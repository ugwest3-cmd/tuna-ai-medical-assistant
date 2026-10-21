/**
 * Vercel Serverless Function: Diagnostic Lab & Scan Result Interpreter
 * Powered by Groq Vision (llama-3.2-11b-vision-preview) and Uganda Clinical Guidelines.
 */
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const SUPABASE_URL = process.env.SUPABASE_URL || "https://tormcjsptsstcmsaebsl.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_rNWGdkRSuYcd1nm_58TSjw_mAj6pAoV";
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const groq = new Groq({ apiKey: GROQ_API_KEY });

const LAB_SYSTEM_PROMPT = `You are Tuna AI's Clinical Pathology & Diagnostic Interpretation Engine, built for healthcare providers in Uganda.

Your duty is to read, extract, analyze, and interpret medical laboratory tests, diagnostic scan reports (Ultrasound, X-ray, CT), and test strips according to standard reference ranges and the UGANDA CLINICAL GUIDELINES (UCG).

FORMATTING & CLINICAL RULES:
1. NO PAGE NUMBERS OR BOOK CITATIONS.
2. EXTRACT EXACT VALUES: Carefully read patient values and compare them against normal adult/pediatric reference intervals.
3. CLEAR STEPS & DOSAGES: Provide immediate actionable management steps with exact drug dosages where indicated under UCG.
4. HIGH-RISK / CRITICAL VALUES: Clearly highlight life-threatening abnormal results.

STRUCTURE YOUR LAB / SCAN REPORT EXACTLY AS FOLLOWS:

🧪 *LABORATORY & SCAN FINDINGS*
• [Test Parameter]: [Patient Value] | Normal: [Reference Range] ➔ *[NORMAL / HIGH / LOW / CRITICAL]*
(List all detected parameters cleanly)

🔬 *CLINICAL INTERPRETATION & DDx*
(Concise synthesis: What does this pattern of findings indicate? Most likely primary diagnosis and secondary differentials in Uganda)

📋 *RECOMMENDED UCG CLINICAL ACTION*
• *Step 1: Immediate Stabilization / First-Line Drug*
  - Drug: [Exact Name]
  - Dosage & Route: [Exact dose: mg/kg for pediatrics or adult dose]
  - Administration: [e.g., IV / Oral, frequency and duration]

• *Step 2: Corrective Therapy / Supportive Management*
  - [e.g. IV fluids, blood product transfusion calculation, electrolyte correction, oxygen]

• *Step 3: Confirmatory & Follow-Up Diagnostics*
  - [Essential secondary investigations, e.g., Blood slide for MP, Liver enzymes, Repeat Hb in 24h]

🚨 *CRITICAL RED FLAGS FOR REFERRAL*
• [Specific laboratory or clinical markers indicating urgent ICU or surgical referral]`;

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

    const { user_id, image_base64, mime_type = 'image/jpeg', text_data, clinical_notes } = req.body || {};

    if (!image_base64 && !text_data) {
        return res.status(400).json({ error: 'Provide either image_base64 or text_data.' });
    }

    try {
        // Atomic credit deduction if user_id is provided
        if (user_id) {
            const { data: deducted } = await supabase.rpc('deduct_credit', {
                p_user_id: user_id,
                p_amount: 1
            });

            if (!deducted) {
                return res.status(200).json({
                    status: 'insufficient_credits',
                    message: '⚠️ *Insufficient Balance:* You have 0 credits remaining.\n\nReply *BUY* to view top-up packages.'
                });
            }
        }

        let userContent = [];
        let promptText = "Examine this medical laboratory test or diagnostic scan result. Transcribe visible parameters, identify abnormalities, and outline the exact UCG management protocol and dosages.";
        if (clinical_notes) promptText += `\nClinical Notes: ${clinical_notes}`;

        if (image_base64) {
            userContent = [
                { type: "text", text: promptText },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:${mime_type};base64,${image_base64}`
                    }
                }
            ];
        } else {
            userContent = `LAB / SCAN DATA:\n${text_data}\n\n${promptText}`;
        }

        const visionModel = process.env.GROQ_VISION_MODEL || "llama-3.2-11b-vision-preview";

        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: LAB_SYSTEM_PROMPT },
                { role: "user", content: userContent }
            ],
            model: visionModel,
            temperature: 0.15,
            max_tokens: 1400
        });

        const interpretation = completion.choices[0]?.message?.content || "No interpretation generated.";

        if (user_id) {
            await supabase.from('chat_logs').insert({
                user_id: user_id,
                incoming_message: "[Lab / Scan Interpretation Request]",
                ai_response: interpretation
            });
        }

        return res.status(200).json({
            status: "success",
            response: interpretation
        });

    } catch (err) {
        console.error('[Vercel Lab Interpretation Error]', err.message);
        return res.status(500).json({ error: err.message });
    }
};
