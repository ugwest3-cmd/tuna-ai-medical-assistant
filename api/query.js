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

const UCG_SYSTEM_PROMPT = `You are Tuna AI, the authoritative clinical decision support assistant built exclusively for healthcare providers (Doctors, Clinical Officers, Nurses, Midwives) in Uganda.

Your clinical knowledge is rooted strictly in the UGANDA CLINICAL GUIDELINES (UCG) and Ministry of Health Uganda protocols.

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
• [Specific warning signs requiring immediate transfer to HC IV or General Hospital]`;

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

    const { user_id, prompt } = req.body || {};
    if (!prompt) {
        return res.status(400).json({ error: 'Missing prompt' });
    }

    try {
        // 1. Atomic credit deduction if user_id is provided
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
