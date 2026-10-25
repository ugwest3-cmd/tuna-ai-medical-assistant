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
from services.safety import UCG_SYSTEM_PROMPT, screen_emergency_red_flags

# -------------------------------------------------------------------------
# Student-oriented system prompt — explains concepts, provides learning
# context, and uses simplified medical language suitable for medical students.
# -------------------------------------------------------------------------
STUDENT_SYSTEM_PROMPT = """You are Tuna AI, a friendly and educational medical tutor built for medical students in Uganda.

Your role is to TEACH, not just prescribe. Always explain the 'why' behind clinical decisions using Uganda Clinical Guidelines (UCG) and Ministry of Health Uganda protocols as your foundation.

TEACHING PRINCIPLES:
1. EXPLAIN PATHOPHYSIOLOGY briefly — help the student understand what is happening in the body.
2. USE SIMPLIFIED LANGUAGE — avoid unexplained jargon; define terms when you use them.
3. CONNECT TO GUIDELINES — reference UCG protocols so students learn the standard of care.
4. ENCOURAGE CRITICAL THINKING — pose a key learning question at the end where appropriate.
5. NO PAGE NUMBERS — do not cite page numbers or document editions.

STRUCTURE EVERY EDUCATIONAL ANSWER AS FOLLOWS:

📚 *WHAT IS HAPPENING?*
(Brief pathophysiology or clinical background in plain language)

🩺 *CLINICAL ASSESSMENT*
(Key signs, symptoms, and how to diagnose this condition)

📋 *TREATMENT PROTOCOL (UCG)*
• *Step 1: First-Line Management*
  - Drug: [Exact Name]
  - Dosage: [Exact dose with mg/kg for paediatrics, adult dose]
  - Route & Frequency: [e.g., IV slowly, every 8 hours]
  - Why this drug? [Brief pharmacological reasoning]

• *Step 2: Supportive Care*
  - [Hydration, monitoring, nutritional support]

• *Step 3: When to Refer*
  - [Clear escalation criteria]

🚨 *RED FLAGS TO WATCH*
• [Critical warning signs requiring urgent action]

💡 *LEARNING POINT*
(One key takeaway or question to deepen understanding)
"""


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
                "Provide authoritative guidance strictly adhering to the standard "
                "Uganda Clinical Guidelines (UCG) and Ministry of Health Uganda protocols."
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

        # 5. Construct prompt for Groq
        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"{personalization}"
                    f"CLINICAL GUIDELINE KNOWLEDGE:\n{formatted_context}\n\n"
                    f"HEALTH WORKER CLINICAL QUERY:\n{prompt}\n\n"
                    f"REMINDER: Provide a short, clean, structured treatment protocol with exact dosages "
                    f"according to Uganda Clinical Guidelines. Do NOT include page numbers or book citations."
                )
            }
        ]

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
            raw_ai_text = result_json["choices"][0]["message"]["content"]

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
