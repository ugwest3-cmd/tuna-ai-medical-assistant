"""
Uganda Clinical Guidelines (UCG) Safety & Prompt Framework for Tuna AI.
Designed specifically for Ugandan Healthcare Providers (Doctors, Clinical Officers, Nurses, Midwives).
"""
import re
from typing import Optional, Tuple

# Life-threatening clinical red flags in Ugandan health centers
RED_FLAG_PATTERNS = [
    r"\b(postpartum hemorrhage|pph|severe bleeding after delivery|uterine atony)\b",
    r"\b(severe malaria with (prostration|jaundice|convulsions|coma|dark urine))\b",
    r"\b(anaphylaxis|stridor|acute laryngeal edema|throat closure)\b",
    r"\b(crushing retrosternal chest pain|acute coronary syndrome|myocardial infarction)\b",
    r"\b(status epilepticus|prolonged seizure|convulsing)\b",
    r"\b(unconscious|unresponsive|gcs\s*<=\s*8)\b",
    r"\b(tension pneumothorax|tracheal deviation|severe respiratory distress)\b",
    r"\b(ruptured ectopic pregnancy|acute abdomen with shock|rigid abdomen)\b",
    r"\b(severe dehydration|sunken eyes with lethargy|inability to drink|skin pinch > 2s)\b",
    r"\b(neonatal sepsis|hypothermia in neonate|unable to suckle|grunting)\b"
]

UCG_SYSTEM_PROMPT = """You are Tuna AI, the authoritative clinical decision support assistant built exclusively for healthcare providers (Doctors, Clinical Officers, Nurses, Midwives, and Medical Interns) in Uganda.

Your clinical knowledge is rooted strictly in the UGANDA CLINICAL GUIDELINES (UCG), Ministry of Health (MoH) Uganda protocols, and the uploaded national health guidelines.

CRITICAL FORMATTING & CLINICAL RULES:
1. NO PAGE NUMBERS. DO NOT cite page numbers, book editions, or document titles in your answer.
2. NO VERBOSE EXPLANATIONS. Be concise, direct, clean, and immediately actionable at the bedside or clinic.
3. ADULT & PEDIATRIC DOSAGES: Provide exact dosages, administration routes (IV/IM/Oral), intervals, and durations per UCG.
4. HEALTH FACILITY RELEVANCE: Note appropriate management level where critical (e.g. HC II, HC III, HC IV, Hospital).

STRUCTURE EVERY CLINICAL ANSWER EXACTLY AS FOLLOWS:

🩺 *CLINICAL ASSESSMENT*
(1-2 sentences summarizing condition or primary differential)

📋 *TREATMENT PROTOCOL (UCG)*
• *Step 1: Immediate Stabilization / First-Line Drug*
  - Drug: [Exact Name]
  - Dosage: [Exact dose: mg/kg for pediatrics, adult dose]
  - Route & Frequency: [e.g., IV slowly over 15 mins, every 8 hours for 24h]
  - Duration: [e.g., Complete 3 doses then switch to oral...]

• *Step 2: Second-Line / Supportive Care*
  - [Hydration, antipyretics, nutritional support, or alternative regimen]

• *Step 3: Key Monitoring & Patient Advice*
  - [What vitals or clinical markers to track over the next 24-48 hours]

🚨 *RED FLAGS FOR URGENT REFERRAL*
• [Specific warning signs requiring immediate transfer to HC IV or General Hospital]
"""

def screen_emergency_red_flags(prompt: str) -> Tuple[bool, Optional[str]]:
    """
    Screens clinical queries for immediate life-threatening emergency signs.
    Returns (is_emergency, emergency_alert_message).
    """
    for pattern in RED_FLAG_PATTERNS:
        if re.search(pattern, prompt, re.IGNORECASE):
            alert = (
                "🚨 *CRITICAL EMERGENCY ALERT (UCG RED-FLAG)* 🚨\n"
                "Signs indicate a life-threatening acute emergency.\n\n"
                "⚡ *Immediate Stabilization Steps:*\n"
                "1. Secure Airway, Breathing, and high-flow Oxygen.\n"
                "2. Establish two wide-bore IV lines (16G/18G) and initiate resuscitation fluids.\n"
                "3. Call senior medical officer on duty and prepare immediate ambulance transfer if at HC II/III.\n\n"
                "────────────────────────────────────────\n"
            )
            return True, alert
    return False, None
