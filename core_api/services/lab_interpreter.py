"""
Lab & Scan Result Interpreter Service for Tuna AI.
Uses Groq Vision (llama-3.2-11b-vision-preview) and text models to interpret
clinical laboratory slips, blood tests, biochemistry panels, ultrasound, and radiology scan reports.
"""
import httpx
from typing import Dict, Any, Optional
from config import settings

LAB_SYSTEM_PROMPT = """You are Tuna AI's Clinical Pathology & Diagnostic Interpretation Engine, built for healthcare providers in Uganda.

Your duty is to read, extract, analyze, and interpret medical laboratory tests, diagnostic scan reports (Ultrasound, X-ray, CT), and test strips according to standard reference ranges and the UGANDA CLINICAL GUIDELINES (UCG).

⚡ STRICT BREVITY & SUMMARY DIRECTIVE:
Health workers need ultra-concise, summarized, scannable findings. Maximum 130–150 words total.
• Highlight abnormal or critical values individually with reference ranges.
• Group normal tests into a single compact summary line.
• Zero conversational fluff or narrative filler.
• NO PAGE NUMBERS OR BOOK CITATIONS.

STRUCTURE YOUR LAB / SCAN REPORT AS FOLLOWS:

🧪 *KEY FINDINGS (ABNORMAL & CRITICAL)*
• [Test Parameter]: [Patient Value] | Normal: [Ref Range] ➔ *[HIGH / LOW / CRITICAL]*
• _Normal/Negative Parameters:_ [List in one compact line]

🔬 *CLINICAL IMPRESSION*
[1-2 sentences summarizing clinical diagnosis and top differential in Uganda]

📋 *IMMEDIATE UCG MANAGEMENT*
• *First-Line Intervention:* [Drug/procedure, exact dose, route, duration in 1 line]
• *Supportive Care:* [Fluids/electrolytes/monitoring in 1 line]
• *Follow-up Diagnostics:* [Essential secondary test in 1 line]

🚨 *DANGER SIGNS / REFERRAL*
• [Specific markers requiring urgent surgical or ICU referral]
"""

class LabInterpreter:
    def __init__(self):
        self.api_key = settings.GROQ_API_KEY
        self.base_url = settings.GROQ_API_BASE_URL
        self.vision_model = settings.GROQ_VISION_MODEL
        self.text_model = settings.GROQ_TEXT_MODEL

    async def interpret_from_image(self, image_base64: str, mime_type: str = "image/jpeg", user_notes: Optional[str] = None) -> str:
        """
        Interprets a photo of a lab slip, CBC printout, rapid test strip, or scan report using Groq Vision.
        """
        prompt_text = "Please examine this medical laboratory test / scan result image. Transcribe all visible parameters, interpret abnormal values, and provide clinical management steps according to Uganda Clinical Guidelines."
        if user_notes:
            prompt_text += f"\n\nAdditional Clinical Context from Health Worker: {user_notes}"

        image_url_content = f"data:{mime_type};base64,{image_base64}"

        messages = [
            {"role": "system", "content": LAB_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt_text},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_url_content
                        }
                    }
                ]
            }
        ]

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": self.vision_model,
            "messages": messages,
            "temperature": 0.15,
            "max_tokens": 1200
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json=payload
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Groq Vision API failed [{resp.status_code}]: {resp.text}")
            result_json = resp.json()
            choice = result_json.get("choices", [{}])[0]
            message = choice.get("message", {})
            return (message.get("content") or message.get("reasoning_content") or message.get("refusal") or "").strip()

    async def interpret_from_text(self, lab_text: str) -> str:
        """
        Interprets lab / scan results provided as raw text by the health worker.
        """
        messages = [
            {"role": "system", "content": LAB_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"HEALTH WORKER LAB / SCAN DATA:\n{lab_text}\n\nAnalyze these laboratory / diagnostic scan values, identify abnormalities, and outline the exact UCG management protocol and dosages."
            }
        ]

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": self.text_model,
            "messages": messages,
            "temperature": 0.15,
            "max_tokens": 1200
        }

        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json=payload
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Groq Text API failed [{resp.status_code}]: {resp.text}")
            result_json = resp.json()
            choice = result_json.get("choices", [{}])[0]
            message = choice.get("message", {})
            return (message.get("content") or message.get("reasoning_content") or message.get("refusal") or "").strip()
