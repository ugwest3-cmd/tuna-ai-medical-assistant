"""
RAG Engine: Vector search against Supabase pgvector and Groq LLM completion.
Strictly configured for Uganda Clinical Guidelines (UCG).
"""
import httpx
from typing import Dict, Any, List
from supabase import create_client, Client
from sentence_transformers import SentenceTransformer

from config import settings
from services.safety import UCG_SYSTEM_PROMPT, screen_emergency_red_flags

class RAGEngine:
    def __init__(self):
        self.supabase: Client = create_client(
            settings.SUPABASE_URL,
            settings.SUPABASE_SERVICE_ROLE_KEY
        )
        # Load local embedding model (1024 dimensions)
        self.embed_model = SentenceTransformer(settings.EMBEDDING_MODEL_NAME)

    def retrieve_context(self, query: str, match_count: int = 4, threshold: float = 0.55) -> List[str]:
        """
        Embeds the query and performs pgvector similarity search via Supabase RPC.
        Returns clean content chunks without page numbers or book metadata.
        """
        try:
            query_vector = self.embed_model.encode(query, normalize_embeddings=True).tolist()
            rpc_res = self.supabase.rpc(
                "match_medical_knowledge",
                {
                    "query_embedding": query_vector,
                    "match_threshold": threshold,
                    "match_count": match_count
                }
            ).execute()
            
            records = rpc_res.data or []
            return [r["content"] for r in records if "content" in r]
        except Exception as e:
            print(f"[RAG Engine] Vector retrieval error: {e}")
            return []

    async def generate_response(self, user_id: str, prompt: str) -> Dict[str, Any]:
        """
        Orchestrates retrieval, emergency triage checks, Groq generation, and chat logging.
        """
        # 1. Check for life-threatening emergency signs
        is_emergency, emergency_alert = screen_emergency_red_flags(prompt)

        # 2. Retrieve guideline content chunks
        context_chunks = self.retrieve_context(prompt)

        if context_chunks:
            formatted_context = "\n\n---\n\n".join(context_chunks)
        else:
            formatted_context = "Provide authoritative guidance strictly adhering to the standard Uganda Clinical Guidelines (UCG) and Ministry of Health Uganda protocols."

        # 3. Construct prompt for Groq
        messages = [
            {"role": "system", "content": UCG_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"CLINICAL GUIDELINE KNOWLEDGE:\n{formatted_context}\n\n"
                    f"HEALTH WORKER CLINICAL QUERY:\n{prompt}\n\n"
                    f"REMINDER: Provide a short, clean, structured treatment protocol with exact dosages according to Uganda Clinical Guidelines. Do NOT include page numbers or book citations."
                )
            }
        ]

        # 4. Call Groq AI API
        headers = {
            "Authorization": f"Bearer {settings.GROQ_API_KEY}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": settings.GROQ_TEXT_MODEL,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": 1200
        }

        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(
                f"{settings.GROQ_API_BASE_URL}/chat/completions",
                headers=headers,
                json=payload
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Groq API request failed [{resp.status_code}]: {resp.text}")
            result_json = resp.json()
            raw_ai_text = result_json["choices"][0]["message"]["content"]

        # 5. Prepend emergency alert if triggered
        final_response = f"{emergency_alert}{raw_ai_text}" if emergency_alert else raw_ai_text

        # 6. Audit log to Supabase
        try:
            self.supabase.table("chat_logs").insert({
                "user_id": user_id,
                "incoming_message": prompt,
                "ai_response": final_response,
                "cited_sources": []
            }).execute()
        except Exception as log_err:
            print(f"[RAG Engine] Chat log insert warning: {log_err}")

        return {
            "response": final_response,
            "is_emergency": is_emergency
        }
