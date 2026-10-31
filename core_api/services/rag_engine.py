"""
RAG Engine: Vector search against Supabase pgvector and Groq LLM completion.
Strictly configured for Uganda Clinical Guidelines (UCG).
Supports role-differentiated prompting (professional vs student) and case-level message logging.
"""
import httpx
from typing import Dict, Any, List, Optional
from supabase import create_client, Client
from sentence_transformers import SentenceTransformer

from config import settings
from services.safety import UCG_SYSTEM_PROMPT, STUDENT_SYSTEM_PROMPT, screen_emergency_red_flags


class RAGEngine:
    def __init__(self):
        self.supabase: Client = create_client(
            settings.SUPABASE_URL,
            settings.SUPABASE_SERVICE_ROLE_KEY
        )
        # Load local embedding model (1024 dimensions)
        self.embed_model = SentenceTransformer(settings.EMBEDDING_MODEL_NAME)

    def retrieve_context(
        self,
        query: str,
        match_count: int = 4,
        threshold: float = 0.55,
        doc_type: str = "professional"
    ) -> List[str]:
        """
        Embeds the query and performs pgvector similarity search via Supabase RPC.
        When doc_type is provided, calls match_medical_knowledge_by_type to filter
        knowledge chunks by audience type (professional or student).
        Falls back to match_medical_knowledge if the typed search returns no results.
        Returns clean content chunks without page numbers or book metadata.
        """
        try:
            query_vector = self.embed_model.encode(query, normalize_embeddings=True).tolist()

            # Prefer role-filtered search using doc_type
            rpc_res = self.supabase.rpc(
                "match_medical_knowledge_by_type",
                {
                    "query_embedding": query_vector,
                    "match_threshold": threshold,
                    "match_count": match_count,
                    "p_doc_type": doc_type
                }
            ).execute()

            records = rpc_res.data or []

            # If no typed results found, fall back to the unfiltered search
            if not records:
                fallback_res = self.supabase.rpc(
                    "match_medical_knowledge",
                    {
                        "query_embedding": query_vector,
                        "match_threshold": threshold,
                        "match_count": match_count
                    }
                ).execute()
                records = fallback_res.data or []

            return [r["content"] for r in records if "content" in r]

        except Exception as e:
            print(f"[RAG Engine] Vector retrieval error: {e}")
            return []

    def retrieve_case_history(
        self,
        case_id: str,
        limit: int = 10
    ) -> List[Dict[str, str]]:
        """
        Fetches the recent conversation messages for a given case_id from case_messages.
        Returns a list of {"role": "user"|"assistant", "content": "..."} dicts suitable
        for inclusion in Groq's messages array.
        """
        try:
            result = self.supabase.table("case_messages") \
                .select("direction, content, created_at") \
                .eq("case_id", case_id) \
                .order("created_at", desc=False) \
                .limit(limit) \
                .execute()

            history = []
            for row in (result.data or []):
                role = "user" if row["direction"] == "inbound" else "assistant"
                history.append({"role": role, "content": row["content"]})
            return history
        except Exception as e:
            print(f"[RAG Engine] Case history retrieval error: {e}")
            return []

    async def generate_response(
        self,
        user_id: str,
        prompt: str,
        user_name: str = "",
        user_role: str = "professional",
        case_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Orchestrates retrieval, emergency triage checks, Groq generation, and chat logging.
        Supports personalized prompting based on user_name and user_role.
        Passes conversation history from case_messages so the AI has full session memory.
        Logs inbound/outbound messages to case_messages table when case_id is provided.
        """
        # 1. Check for life-threatening emergency signs
        is_emergency, emergency_alert = screen_emergency_red_flags(prompt)

        # 2. Retrieve guideline content chunks filtered by user role
        context_chunks = self.retrieve_context(prompt, doc_type=user_role)

        if context_chunks:
            formatted_context = "\n\n---\n\n".join(context_chunks)
        else:
            formatted_context = (
                "[NO SPECIFIC UCG EXTRACT FOUND FOR THIS QUERY. Adhere to standard UCG fundamentals. "
                "If the topic is outside national primary care guidelines, state clearly that UCG lacks "
                "a standardized protocol for this condition rather than speculating.]"
            )

        # 3. Select system prompt based on user role
        if user_role == "student":
            system_prompt = STUDENT_SYSTEM_PROMPT
        else:
            system_prompt = UCG_SYSTEM_PROMPT

        # 4. Personalise the user message with the user's name and role if known
        personalization = ""
        if user_name:
            role_label = "Medical Student" if user_role == "student" else user_role.capitalize()
            personalization = f"You are speaking with {user_name}, a {role_label}.\n\n"

        # 5. Build message array — start with system, inject context, then conversation history
        system_content = (
            f"{system_prompt}\n\n"
            f"═══════════════════════════\n"
            f"CLINICAL GUIDELINE KNOWLEDGE (UCG):\n{formatted_context}\n"
            f"═══════════════════════════\n"
            f"{personalization}"
        )

        messages: List[Dict[str, str]] = [
            {"role": "system", "content": system_content}
        ]

        # 5a. Inject conversation history (previous turns of this case) for multi-turn memory
        if case_id:
            history = self.retrieve_case_history(case_id, limit=10)
            messages.extend(history)

        # 5b. Append the current user message
        messages.append({
            "role": "user",
            "content": (
                f"{prompt}\n\n"
                f"[STRICT BREVITY & SUMMARY DIRECTIVE:\n"
                f"Ugandan health workers need ultra-concise, summarized, scannable bedside guidance.\n"
                f"• Maximum 120-150 words total. Zero conversational fluff.\n"
                f"• Vitals First: Request critical vitals (Temp, BP, Pulse, RR, Wt) before prescribing.\n"
                f"• Single Question: Ask ONLY ONE high-yield question.\n"
                f"• Ranked Differentials: 1-line reason each (max 6 words per line).\n"
                f"• Treatment Locked: No drug doses unless diagnosis is confirmed.\n"
                f"• Zero page numbers or citations.]"
            )
        })

        # 6. Log the inbound message to case_messages if a case_id is provided
        if case_id:
            try:
                self.supabase.table("case_messages").insert({
                    "case_id": case_id,
                    "user_id": user_id,
                    "direction": "inbound",
                    "content": prompt
                }).execute()
            except Exception as log_err:
                print(f"[RAG Engine] Case message (inbound) log warning: {log_err}")

        # 7. Call Groq AI API
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
            choice = result_json.get("choices", [{}])[0]
            message = choice.get("message", {})
            raw_ai_text = (
                message.get("content") 
                or message.get("reasoning_content") 
                or message.get("refusal") 
                or ""
            ).strip()

            if not raw_ai_text:
                print(f"[RAG Engine Warning] Empty Groq completion: {result_json}")
                raise RuntimeError("Groq completion returned empty content.")

        # 8. Prepend emergency alert if triggered
        final_response = f"{emergency_alert}{raw_ai_text}" if emergency_alert else raw_ai_text

        # 9. Log the outbound AI response to case_messages if a case_id is provided
        if case_id:
            try:
                self.supabase.table("case_messages").insert({
                    "case_id": case_id,
                    "user_id": user_id,
                    "direction": "outbound",
                    "content": final_response
                }).execute()
            except Exception as log_err:
                print(f"[RAG Engine] Case message (outbound) log warning: {log_err}")

        # 10. Audit log to Supabase chat_logs
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
