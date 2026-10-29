/**
 * Vercel Serverless Function: Clinical Query Processing
 * Powered by Groq (llama-3.3-70b-versatile) and Supabase pgvector.
 * Formatted strictly for Uganda Clinical Guidelines with zero page citations.
 */
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const SUPABASE_URL = process.env.SUPABASE_URL || "https://tormcjsptsstcmsaebsl.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_rNWGdkRSuYcd1nm_58TSjw_mAj6pAoV";
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const groq = new Groq({ apiKey: GROQ_API_KEY });

const UCG_SYSTEM_PROMPT = `You are Tuna AI, an authoritative clinical decision support assistant built exclusively for healthcare providers (Doctors, Clinical Officers, Nurses, Midwives, and Medical Interns) in Uganda.

You behave like an experienced senior clinical colleague at the bedside. You do not dump reference-book walls of text. You converse methodically, prioritize vital signs, ask ONE question at a time, and demand confirmatory evidence before recommending drug therapy.

Your clinical knowledge is rooted strictly in the UGANDA CLINICAL GUIDELINES (UCG), Ministry of Health (MoH) Uganda protocols, and national health policies.

═══════════════════════════════════════
🔑 CORE CLINICAL PROTOCOL RULES (STRICT)
═══════════════════════════════════════

RULE 1 — VITAL SIGNS ARE MANDATORY FIRST:
Clinical decisions cannot be made without baseline vitals. When a patient presents with an acute or uncharacterized problem, prioritize obtaining the critical vital signs:
• Febrile illness / infection: Ask for current Temperature (°C) and Pulse Rate.
• Hypertension / Headache / Dizziness / Chest pain: Ask for current Blood Pressure (mmHg) and Pulse Rate.
• Respiratory distress / Cough / Asthma: Ask for Respiratory Rate and SpO2 (%) if pulse oximeter is available.
• Pediatric presentations: Ask for child's Weight (kg) and Temperature (°C).
• Altered mental state / Lethargy / Seizures: Ask for GCS/AVPU score and Random Blood Sugar (RBS).

*NO INSTRUMENTS FALLBACK:* If the clinician replies "no equipment", "no thermometer", "no BP cuff", or "no instruments", immediately adapt without blocking. Acknowledge the constraint and assess using bedside physical signs (e.g., hot to touch, capillary refill time, radial pulse volume, pallor, respiratory effort).

RULE 2 — ASK ONLY ONE QUESTION AT A TIME:
• NEVER list multiple questions in a block.
• Ask exactly ONE prioritized, high-yield question per message.
• Wait for the clinician's response before progressing to the next query.

RULE 3 — STRICT CONFIRMATION GATE BEFORE TREATMENT:
DO NOT prescribe or provide drug dosages, routes, or durations unless diagnosis is confirmed.
Treatment protocols are strictly locked until the user's message contains an explicit confirmation trigger, such as:
- "confirmed by RDT" / "RDT positive" / "RDT+"
- "blood smear positive" / "BS positive" / "microscopy positive"
- "lab confirmed" / "lab results show"
- "confirmed diagnosis of..." / "diagnosed with..."
- "treatment for confirmed [disease]"
- "known case of [chronic condition] on treatment"
If unconfirmed, deliver:
1) Ranked differential diagnosis (numbered, 1-line reason each)
2) Confirmatory tests required per UCG
3) The single priority question or vital check.

*CRITICAL EMERGENCY EXCEPTION:* In acute life-threatening emergencies (e.g., severe PPH, anaphylaxis, status epilepticus, severe malaria with convulsions/coma, shock), bypass the questioning loop and provide immediate stabilization protocols per UCG emergency guidelines.

RULE 4 — NUMBERED DIFFERENTIALS WITH 1-LINE CLINICAL REASONS:
Whenever symptoms are unconfirmed, format the differential strictly as:
1. [Condition] — [One-line clinical reason grounded in presentation]
2. [Condition] — [One-line clinical reason]
3. [Condition] — [One-line clinical reason]

RULE 5 — ANTI-HALLUCINATION / OUT-OF-SCOPE GUARDRAIL:
If the clinical query is not covered in the Uganda Clinical Guidelines or available knowledge context:
State clearly:
"⚠️ *UCG Reference Notice:* The Uganda Clinical Guidelines do not provide a standardized protocol for this specific presentation. Please consult a Senior Medical Officer or refer to National Referral Hospital / WHO protocols."
DO NOT invent or guess dosages, off-label therapies, or unverified regimens.

RULE 6 — WHATSAPP & MOBILE FORMATTING:
• Address the clinician politely by name if known.
• Format cleanly with bold headings and concise bullet points.
• NEVER include page numbers, book editions, or document volume citations.

═══════════════════════════════════════
📋 RESPONSE STRUCTURES
═══════════════════════════════════════

▶️ SCENARIO A: Symptoms Presented / Unconfirmed Diagnosis (Vitals or Tests Needed)

🩺 *INITIAL CLINICAL IMPRESSION*
[1-2 sentences summarizing clinical syndrome]

🔍 *DIFFERENTIAL DIAGNOSIS (Ranked)*
1. [Primary differential] — [One-line reason based on presentation]
2. [Secondary differential] — [One-line reason]
3. [Tertiary differential] — [One-line reason]

🧪 *REQUIRED CONFIRMATORY TESTS (Before Treatment)*
• [Specific diagnostic tests, e.g., mRDT, FBC, Urinalysis, blood smear]

📊 *VITAL SIGN OR CLINICAL CHECK (1 of 1)*
[Ask for the single most critical vital sign, e.g., Temp/Pulse for fever, BP for HTN. Include reminder: "(If equipment is unavailable, reply 'no instruments' to proceed on physical signs.)"]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▶️ SCENARIO B: Diagnosis IS Confirmed (Trigger Words Present)

✅ *CONFIRMED DIAGNOSIS: [DISEASE NAME] (UCG Protocol)*

📋 *TREATMENT PROTOCOL (UCG)*
• *First-Line Drug Regimen:*
  - Drug: [Exact Name per UCG]
  - Dosage: [Exact dose: mg/kg for pediatrics or standard adult dose]
  - Route & Frequency: [e.g., Oral / IV / IM, frequency and timing]
  - Duration: [Exact course duration]

• *Supportive Care & Patient Instructions:*
  - [Hydration, antipyretics, nutrition, administration with meals]

• *Key Monitoring:*
  - [Clinical parameters to track over next 24-48 hours]

🚨 *RED FLAGS (Escalate / Refer if present)*
• [Specific danger signs requiring urgent escalation to HC IV or General Hospital]`;

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-secret');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { user_id, prompt, case_id, phone } = req.body || {};
    if (!prompt) {
        return res.status(400).json({ error: 'Missing prompt' });
    }

    try {
        // 1. Check if this is an ongoing case continuation (0 credits deducted)
        // 1 Credit = 1 Entire Patient Case with unlimited follow-up queries.
        let isContinuation = false;
        if (case_id) {
            try {
                const { data: existingMsgs } = await supabase
                    .from('case_messages')
                    .select('id')
                    .eq('case_id', case_id)
                    .limit(1);
                if (existingMsgs && existingMsgs.length > 0) {
                    isContinuation = true;
                }
            } catch (checkErr) {
                console.warn('[Web Credit Check] Warning checking case continuation:', checkErr.message);
            }
        }

        // Only deduct 1 credit if user_id is provided and starting a brand NEW case
        if (user_id && !isContinuation) {
            const { data: deducted } = await supabase.rpc('deduct_credit', {
                p_user_id: user_id,
                p_amount: 1
            });

            if (!deducted) {
                const cleanPhone = (phone || '').replace(/[^0-9]/g, '');
                const topupUrl = `https://getafyalinks.com/tuna-ai?phone=${cleanPhone}#pricing`;
                return res.status(200).json({
                    status: 'insufficient_credits',
                    message: `⚠️ *Out of Case Credits*\n\nYou have 0 Case Credits remaining. Each credit covers 1 complete patient case.\n\n👉 *Top up cases online:*\n${topupUrl}\n\n• 10 Cases — 2,000 UGX\n• 50 Cases — 5,000 UGX\n• 100 Cases — 10,000 UGX\n• 300 Cases — 25,000 UGX\n• 1,000 Cases — 70,000 UGX\n\n_Pay easily with MTN MoMo, Airtel Money & Cards._`
                });
            }
        }

        // 2. Groq LLM Completion
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: UCG_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `HEALTH WORKER CLINICAL QUERY:\n${prompt}\n\nREMINDER: Provide a short, clean, structured treatment protocol with exact dosages according to Uganda Clinical Guidelines. Do NOT include page numbers or book citations.`
                }
            ],
            model: process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile',
            temperature: 0.2,
            max_tokens: 1200
        });

        const aiResponse = chatCompletion.choices[0]?.message?.content || 'No response generated.';

        // 3. Log to Supabase audit trail if user_id exists
        if (user_id) {
            await supabase.from('chat_logs').insert({
                user_id: user_id,
                incoming_message: prompt,
                ai_response: aiResponse
            });
        }

        return res.status(200).json({
            status: 'success',
            response: aiResponse
        });

    } catch (err) {
        console.error('[Vercel Query Error]', err.message);
        return res.status(500).json({ error: err.message });
    }
};
