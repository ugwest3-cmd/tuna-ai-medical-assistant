/**
 * Tuna AI WhatsApp Gateway Worker - Uganda Healthcare Edition
 * Supports:
 * 1. Multi-step onboarding flow (name → profession → practicing number)
 * 2. Clinical Queries (Groq Llama-3.3-70B via Core API)
 * 3. Case context management (reuse open cases within 2 hours)
 * 4. Diagnostic Lab & Scan Result Vision (Interprets photos of lab slips, CBCs, RDTs, scans)
 * 5. Mobile Money Top-Ups (PesaPal v3 / UGX)
 * 6. HISTORY / CASES command for reviewing past cases
 * 7. Response chunking for long AI messages (≤ 900 chars per WhatsApp message)
 * 8. 8-digit Pairing Code support for headless Railway deployments
 */
require('dotenv').config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const express = require('express');
const axios = require('axios');
const path = require('path');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(express.json());

// Allow cross-origin requests from the Vercel admin panel
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-secret');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Configuration
const PORT = process.env.PORT || 8080;
const SESSION_PATH = process.env.SESSION_PATH || (fs.existsSync('/data') ? '/data/tuna_session' : path.join(__dirname, 'session'));
const SUPABASE_URL = process.env.SUPABASE_URL || "https://tormcjsptsstcmsaebsl.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_rNWGdkRSuYcd1nm_58TSjw_mAj6pAoV";
let apiUrl = process.env.CORE_API_URL || process.env.VERCEL_URL || 'http://localhost:8000';
if (apiUrl && !apiUrl.startsWith('http://') && !apiUrl.startsWith('https://')) {
    apiUrl = `https://${apiUrl}`;
}
const CORE_API_URL = apiUrl;
const INTERNAL_SECRET = process.env.INTERNAL_GATEWAY_SECRET || 'tuna-ai-uganda-secret-2026';
const PAIRING_NUMBER = process.env.PHONE_NUMBER_FOR_PAIRING; // e.g. "256701234567"

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    realtime: { transport: ws }
});
let sock = null;
let latestQR = null;          // stores the current QR code string
let waStatus = 'disconnected'; // 'disconnected' | 'qr_ready' | 'online'

// -----------------------------------------------------------------------
// In-memory store for users who are being asked "new case or continuation?"
// Format: { [remoteJid]: { pendingText: string, existingCaseId: string, existingCaseRef: string, askedAt: number } }
// -----------------------------------------------------------------------
const pendingNewCaseConfirm = {};


// Wipe all session files so a clean pairing code can be generated on next start
function clearSession() {
    try {
        if (fs.existsSync(SESSION_PATH)) {
            const files = fs.readdirSync(SESSION_PATH);
            for (const file of files) {
                fs.rmSync(path.join(SESSION_PATH, file), { recursive: true, force: true });
            }
            console.log(`[Worker] Session cleared (${files.length} file(s) removed).`);
        }
    } catch (err) {
        console.error('[Worker] Failed to clear session:', err.message);
    }
}

// -----------------------------------------------------------------------
// UTILITY: sendChunked
// Sends long AI responses in ≤ 900-character chunks with a delay between
// messages to avoid WhatsApp rate-limiting and improve readability.
// -----------------------------------------------------------------------
async function sendChunked(jid, text, socket) {
    const MAX_CHUNK = 900;
    const DELAY_MS = 1200;

    if (!text || text.length <= MAX_CHUNK) {
        // Short enough — send as a single message
        await socket.sendMessage(jid, { text });
        return;
    }

    // Split on sentence / newline boundaries to form natural chunks
    const chunks = [];
    let current = '';

    // Split the text into segments at natural break points
    const segments = text.split(/(?<=\. )|(?<=\n)/);

    for (const segment of segments) {
        if ((current + segment).length <= MAX_CHUNK) {
            current += segment;
        } else {
            if (current.trim()) chunks.push(current.trim());
            // Handle a segment that is itself longer than MAX_CHUNK
            if (segment.length > MAX_CHUNK) {
                const words = segment.split(' ');
                let wordChunk = '';
                for (const word of words) {
                    if ((wordChunk + ' ' + word).trim().length <= MAX_CHUNK) {
                        wordChunk = (wordChunk + ' ' + word).trim();
                    } else {
                        if (wordChunk) chunks.push(wordChunk);
                        wordChunk = word;
                    }
                }
                if (wordChunk) current = wordChunk;
            } else {
                current = segment;
            }
        }
    }
    if (current.trim()) chunks.push(current.trim());

    // Send each chunk with a short delay
    for (const chunk of chunks) {
        await socket.sendMessage(jid, { text: chunk });
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
}

// -----------------------------------------------------------------------
// UTILITY: getOrCreateActiveCase
// Checks if the user has an open case updated within the last 2 hours.
// If the user's message looks like a NEW patient case (not a follow-up),
// it returns { case_id, case_ref, isNew: true, previousCaseRef } so the
// caller can ask the user to confirm whether this is a new case.
// Returns { case_id, case_ref, isNew, previousCaseRef }
// -----------------------------------------------------------------------
async function getOrCreateActiveCase(userId, messageText) {
    const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    // Check for an existing open case updated within the last 2 hours
    const { data: existingCases } = await supabase
        .from('cases')
        .select('id, case_ref, last_updated_at')
        .eq('user_id', userId)
        .eq('status', 'open')
        .gte('last_updated_at', TWO_HOURS_AGO)
        .order('last_updated_at', { ascending: false })
        .limit(1);

    if (existingCases && existingCases.length > 0) {
        const activeCase = existingCases[0];
        // Refresh the timestamp so the 2-hour window resets
        await supabase
            .from('cases')
            .update({ last_updated_at: new Date().toISOString() })
            .eq('id', activeCase.id);
        return { case_id: activeCase.id, case_ref: activeCase.case_ref, isExisting: true };
    }

    // No recent active case — create a new one
    return await createNewCase(userId, messageText);
}

// -----------------------------------------------------------------------
// UTILITY: createNewCase
// Creates a brand new case record and returns its id and ref.
// -----------------------------------------------------------------------
async function createNewCase(userId, messageText) {
    const year = new Date().getFullYear();
    const uniqueSuffix = String(Date.now()).slice(-5);
    const caseRef = `TUN-${year}-${uniqueSuffix}`;
    const caseTitle = (messageText || '').substring(0, 80).trim() || null;

    const { data: newCase, error: caseErr } = await supabase
        .from('cases')
        .insert({
            user_id: userId,
            case_ref: caseRef,
            title: caseTitle,
            status: 'open'
        })
        .select()
        .single();

    if (caseErr) {
        console.error('[Worker] Failed to create case:', caseErr.message);
        return { case_id: null, case_ref: null, isExisting: false };
    }

    return { case_id: newCase.id, case_ref: newCase.case_ref, isExisting: false };
}

// -----------------------------------------------------------------------
// UTILITY: formatCaseHistory
// Formats a list of cases into a WhatsApp-friendly message string.
// -----------------------------------------------------------------------
function formatCaseHistory(cases) {
    if (!cases || cases.length === 0) {
        return '📋 *Your Case History*\n\nNo cases found. Send a patient description to start a new case.';
    }

    const lines = cases.map((c, i) => {
        const title = c.title ? c.title.substring(0, 40) : 'Untitled';
        const date = c.last_updated_at
            ? new Date(c.last_updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
            : '—';
        return `${i + 1}. ${c.case_ref} — ${title} (${date})`;
    });

    return (
        '📋 *Your Case History*\n\n' +
        lines.join('\n') +
        '\n\nReply the case number or send a new patient description.'
    );
}

async function startWhatsAppWorker() {
    console.log(`[Worker] Initializing auth state at: ${SESSION_PATH}`);

    // If CLEAR_SESSION=true is set in Railway Variables, wipe session for fresh pairing
    if (process.env.CLEAR_SESSION === 'true') {
        console.log('[Worker] CLEAR_SESSION=true detected. Wiping session for fresh pairing...');
        clearSession();
    }

    if (!fs.existsSync(SESSION_PATH)) {
        fs.mkdirSync(SESSION_PATH, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'error' }),
        browser: ['Tuna AI Uganda', 'Chrome', '2.0.0'],
        syncFullHistory: false,           // Skip full chat history sync on boot (prevents init query timeouts)
        defaultQueryTimeoutMs: 120000,    // Extended query timeout (120s) for cloud infrastructure resilience
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        markOnlineOnConnect: true
    });

    // 8-Digit Pairing Code (Ideal for Headless Cloud Logs like Railway)
    if (PAIRING_NUMBER && !sock.authState.creds.registered) {
        console.log(`[Worker] Generating pairing code for phone number: ${PAIRING_NUMBER}...`);
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PAIRING_NUMBER.replace(/[^0-9]/g, ''));
                console.log(`\n======================================================`);
                console.log(`  TUNA AI WHATSAPP PAIRING CODE: [ ${code} ]`);
                console.log(`  Enter this code on your WhatsApp mobile device.`);
                console.log(`======================================================\n`);
            } catch (err) {
                console.error('[Worker] Failed to request pairing code:', err.message);
            }
        }, 4000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Capture QR code for the admin panel and terminal
        if (qr) {
            latestQR = qr;
            waStatus = 'qr_ready';
            console.log('[Worker] QR code ready — scan via admin panel at /api/v1/internal/qr');
            if (!PAIRING_NUMBER) {
                try {
                    const qrcodeTerminal = require('qrcode-terminal');
                    qrcodeTerminal.generate(qr, { small: true });
                } catch (_) {}
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[Worker] Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(startWhatsAppWorker, 3000);
            } else {
                console.log('[Worker] Logged out (401). Clearing stale session and restarting for fresh pairing...');
                clearSession();
                setTimeout(startWhatsAppWorker, 3000);
            }
        } else if (connection === 'open') {
            latestQR = null;
            waStatus = 'online';
            console.log('✅ [Worker] Tuna AI WhatsApp Gateway is ONLINE (Uganda Decision Support).');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!messages || messages.length === 0) return;
        const msg = messages[0];

        // Ignore messages sent by the bot itself or without actual content
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid.includes('@g.us')) return; // Direct messages only

        const isImage = !!msg.message.imageMessage;
        const caption = msg.message.imageMessage?.caption || "";
        const text = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text ||
                     caption;

        const cleanText = (text || "").trim();

        try {
            // ----------------------------------------------------------------
            // 1. Fetch or auto-provision user in Supabase
            // ----------------------------------------------------------------
            let { data: user } = await supabase
                .from('users')
                .select('*')
                .eq('whatsapp_id', remoteJid)
                .single();

            // ----------------------------------------------------------------
            // ONBOARDING STEP 0: Brand-new user — insert and start onboarding
            // ----------------------------------------------------------------
            if (!user) {
                console.log(`[Worker] Provisioning new Ugandan health worker: ${remoteJid}`);
                const { data: newUser, error: createErr } = await supabase
                    .from('users')
                    .insert({
                        whatsapp_id: remoteJid,
                        credit_balance: 20,   // initial trial credits; finalised after onboarding
                        onboarding_step: 1,
                        onboarding_complete: false
                    })
                    .select()
                    .single();

                if (createErr) {
                    console.error('[Worker] User creation error:', createErr);
                    return;
                }

                // Welcome message — ask for name
                await sock.sendMessage(remoteJid, {
                    text:
                        '🩺 *Welcome to Tuna AI Medical Assistant (Uganda)* 🇺🇬\n\n' +
                        'Your AI-powered clinical decision support tool, trained on Uganda Clinical Guidelines (UCG).\n\n' +
                        'Let\'s set up your profile in 3 quick steps.\n\n' +
                        '👤 *Step 1 of 3:* What is your full name?'
                });
                return;
            }

            // ----------------------------------------------------------------
            // ONBOARDING STEP 1: Awaiting name
            // ----------------------------------------------------------------
            if (user.onboarding_step === 1) {
                if (!cleanText) return; // ignore empty messages during onboarding

                await supabase
                    .from('users')
                    .update({ name: cleanText, onboarding_step: 2, updated_at: new Date().toISOString() })
                    .eq('id', user.id);

                await sock.sendMessage(remoteJid, {
                    text:
                        `✅ Nice to meet you, *${cleanText}*!\n\n` +
                        '🏥 *Step 2 of 3:* What is your profession?\n\n' +
                        'Reply with a number:\n' +
                        '*1* — Doctor\n' +
                        '*2* — Nurse / Midwife / Clinical Officer\n' +
                        '*3* — Medical Student\n' +
                        '*4* — Other Healthcare Worker'
                });
                return;
            }

            // ----------------------------------------------------------------
            // ONBOARDING STEP 2: Awaiting profession
            // ----------------------------------------------------------------
            if (user.onboarding_step === 2) {
                if (!cleanText) return;

                let profession = '';
                let role = 'professional'; // default role

                switch (cleanText.trim()) {
                    case '1':
                        profession = 'Doctor';
                        role = 'professional';
                        break;
                    case '2':
                        profession = 'Nurse / Midwife / Clinical Officer';
                        role = 'professional';
                        break;
                    case '3':
                        profession = 'Medical Student';
                        role = 'student';
                        break;
                    case '4':
                        profession = 'Other Healthcare Worker';
                        role = 'professional';
                        break;
                    default:
                        // Accept free-text profession input too
                        profession = cleanText;
                        role = 'professional';
                }

                await supabase
                    .from('users')
                    .update({
                        profession,
                        role,
                        onboarding_step: 3,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', user.id);

                await sock.sendMessage(remoteJid, {
                    text:
                        `✅ Profession saved: *${profession}*\n\n` +
                        '🪪 *Step 3 of 3:* Please enter your practicing/registration number ' +
                        '(e.g. UMDPC number, Nursing Council number, or Student ID).\n\n' +
                        '_Reply_ *SKIP* _if you do not have one yet._'
                });
                return;
            }

            // ----------------------------------------------------------------
            // ONBOARDING STEP 3: Awaiting practicing number
            // ----------------------------------------------------------------
            if (user.onboarding_step === 3) {
                if (!cleanText) return;

                const practicingNumber = cleanText.toUpperCase() === 'SKIP' ? null : cleanText;

                // Grant trial credits transaction record now that onboarding is complete
                await supabase.from('credit_transactions').insert({
                    user_id: user.id,
                    amount: 20,
                    tx_type: 'trial_grant',
                    notes: 'Initial free trial credits — onboarding complete'
                });

                // Complete onboarding
                await supabase
                    .from('users')
                    .update({
                        practicing_number: practicingNumber,
                        onboarding_step: 4,
                        onboarding_complete: true,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', user.id);

                // Fetch fresh user data to personalise the welcome message
                const { data: freshUser } = await supabase
                    .from('users')
                    .select('name, profession, role, credit_balance')
                    .eq('id', user.id)
                    .single();

                const firstName = (freshUser?.name || 'there').split(' ')[0];
                const profession = freshUser?.profession || 'Healthcare Provider';
                const credits = freshUser?.credit_balance || 20;

                await sock.sendMessage(remoteJid, {
                    text:
                        `🎉 *Welcome aboard, ${firstName}!*\n\n` +
                        `You are registered as a *${profession}* on Tuna AI Uganda.\n\n` +
                        `💳 You have *${credits} Free Clinical Query Credits* to get started.\n\n` +
                        `*What you can do:*\n` +
                        `• 🩺 Send a patient case for step-by-step UCG treatment protocol\n` +
                        `• 🔬 Send a photo of a lab slip or scan for AI interpretation\n` +
                        `• 📋 Reply *HISTORY* to view your past cases\n` +
                        `• 💳 Reply *BUY* for Mobile Money top-up packages\n\n` +
                        `_Send your first clinical query now!_`
                });
                return;
            }

            // ----------------------------------------------------------------
            // ONBOARDING COMPLETE — proceed to normal message handling below
            // ----------------------------------------------------------------

            // 2. Suspension check
            if (user.status === 'suspended') {
                await sock.sendMessage(remoteJid, {
                    text: '⛔ Your Tuna AI account is currently suspended. Please contact support.'
                });
                return;
            }

            // 3. Handle BUY / Pricing
            if (cleanText.toUpperCase() === 'BUY' || cleanText.toUpperCase() === 'TOPUP' || cleanText.toUpperCase() === 'PRICING') {
                await sock.sendMessage(remoteJid, {
                    text:
                        `💳 *Tuna AI Clinical Top-Up Packages (Uganda)*\n\n` +
                        `Current Balance: *${user.credit_balance} Credits*\n\n` +
                        `Reply with your choice:\n` +
                        `*1* — 100 Credits (10,000 UGX)\n` +
                        `*2* — 300 Credits (25,000 UGX)\n` +
                        `*3* — 1,000 Credits (70,000 UGX)\n\n` +
                        `_Accepted via MTN MoMo, Airtel Money & Visa/Mastercard._`
                });
                return;
            }

            // 4. Handle Package Selection (1 / 2 / 3 for top-up)
            // Note: "1"/"2"/"3" during onboarding are intercepted above; this only runs post-onboarding.
            if (['1', '2', '3'].includes(cleanText) && user.onboarding_complete) {
                await sock.sendMessage(remoteJid, { text: '⏳ Generating your secure PesaPal payment link...' });
                try {
                    const orderRes = await axios.post(
                        `${CORE_API_URL}/api/v1/payments/create-order`,
                        {
                            userId: user.id,
                            phone: remoteJid,
                            packageTier: cleanText
                        },
                        {
                            headers: { 'x-secret': INTERNAL_SECRET },
                            timeout: 15000
                        }
                    );

                    const redirectUrl = orderRes.data.redirect_url;
                    await sock.sendMessage(remoteJid, {
                        text:
                            `🔗 *Secure PesaPal Checkout:*\n${redirectUrl}\n\n` +
                            `Complete with MTN or Airtel Money. Credits will update automatically!`
                    });
                } catch (orderErr) {
                    console.error('[Worker] Error generating payment link:', orderErr.message);
                    await sock.sendMessage(remoteJid, {
                        text: '❌ Failed to generate checkout link. Please try again in a moment.'
                    });
                }
                return;
            }

            // 5. Handle HISTORY / CASES command
            if (cleanText.toUpperCase() === 'HISTORY' || cleanText.toUpperCase() === 'CASES') {
                try {
                    const historyRes = await axios.get(
                        `${CORE_API_URL}/api/v1/cases/history`,
                        {
                            params: { user_id: user.id },
                            headers: { 'x-secret': INTERNAL_SECRET },
                            timeout: 15000
                        }
                    );
                    const caseList = historyRes.data.cases || [];
                    await sock.sendMessage(remoteJid, { text: formatCaseHistory(caseList) });
                } catch (histErr) {
                    console.error('[Worker] Error fetching case history:', histErr.message);
                    await sock.sendMessage(remoteJid, {
                        text: '⚠️ Could not retrieve your case history. Please try again.'
                    });
                }
                return;
            }

            // 6. Check Credit Balance
            if (user.credit_balance <= 0) {
                await sock.sendMessage(remoteJid, {
                    text:
                        `⚠️ *Out of Credits, ${(user.name || 'there').split(' ')[0]}*\n\n` +
                        `You have 0 credits remaining. Please reply *BUY* to replenish your balance.`
                });
                return;
            }

            // 7. Handle DIAGNOSTIC LAB / SCAN IMAGE UPLOAD
            if (isImage) {
                await sock.sendMessage(remoteJid, { text: '🔬 *Analyzing laboratory/scan report using Vision AI...*' });
                await sock.sendPresenceUpdate('composing', remoteJid);

                try {
                    // Download media buffer from WhatsApp
                    const imageBuffer = await downloadMediaMessage(
                        msg,
                        'buffer',
                        {},
                        { logger: pino({ level: 'silent' }) }
                    );

                    const imageBase64 = imageBuffer.toString('base64');
                    const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';

                    const labRes = await axios.post(
                        `${CORE_API_URL}/api/v1/interpret-lab`,
                        {
                            user_id: user.id,
                            phone: remoteJid,
                            image_base64: imageBase64,
                            mime_type: mimeType,
                            clinical_notes: caption
                        },
                        {
                            headers: { 'x-secret': INTERNAL_SECRET },
                            timeout: 90000
                        }
                    );

                    if (labRes.data.status === 'insufficient_credits') {
                        await sock.sendMessage(remoteJid, { text: labRes.data.message });
                    } else if (labRes.data.response) {
                        await sendChunked(remoteJid, labRes.data.response, sock);
                    }
                } catch (imgErr) {
                    console.error('[Worker] Lab interpretation error:', imgErr.message);
                    await sock.sendMessage(remoteJid, {
                        text:
                            '⚠️ *Image Analysis Notice:* Could not clearly read the lab report. ' +
                            'Ensure good lighting, lay the slip flat, and take a clear photo.'
                    });
                }
                return;
            }

            // 8. Handle TEXT CLINICAL QUERY
            if (!cleanText) return;

            await sock.sendPresenceUpdate('composing', remoteJid);

            // ----------------------------------------------------------------
            // NEW-CASE DETECTION: Check if user is responding to "new case?" prompt
            // ----------------------------------------------------------------
            if (pendingNewCaseConfirm[remoteJid]) {
                const pending = pendingNewCaseConfirm[remoteJid];
                delete pendingNewCaseConfirm[remoteJid];

                const reply = cleanText.trim().toLowerCase();

                let activeCaseId, activeCaseRef;

                if (reply === 'new' || reply === '1' || reply.includes('new case')) {
                    // Close the old case and open a fresh one
                    await supabase
                        .from('cases')
                        .update({ status: 'closed' })
                        .eq('id', pending.existingCaseId);

                    const freshCase = await createNewCase(user.id, pending.pendingText);
                    activeCaseId = freshCase.case_id;
                    activeCaseRef = freshCase.case_ref;

                    await sock.sendMessage(remoteJid, {
                        text: `✅ *New Case Started: ${activeCaseRef}*\n\nProcessing your query now...`
                    });
                } else {
                    // Continue with existing case
                    activeCaseId = pending.existingCaseId;
                    activeCaseRef = pending.existingCaseRef;

                    // Refresh the case timestamp
                    await supabase
                        .from('cases')
                        .update({ last_updated_at: new Date().toISOString() })
                        .eq('id', activeCaseId);

                    await sock.sendMessage(remoteJid, {
                        text: `📁 *Continuing Case ${activeCaseRef}*\n\nProcessing your update...`
                    });
                }

                // Now send the pending text to the AI
                await dispatchClinicalQuery(remoteJid, user, pending.pendingText, activeCaseId, activeCaseRef);
                return;
            }

            // ----------------------------------------------------------------
            // STANDARD FLOW: Get or create active case
            // ----------------------------------------------------------------
            let activeCaseId = null;
            let activeCaseRef = null;
            try {
                const caseData = await getOrCreateActiveCase(user.id, cleanText);
                activeCaseId = caseData.case_id;
                activeCaseRef = caseData.case_ref;

                // If this is an EXISTING case, check if the user might be starting a new case.
                // Heuristic: the message is longer than 20 chars AND does NOT start with common
                // follow-up phrases (yes, no, ok, confirmed, results, test, it shows, etc.)
                if (caseData.isExisting && activeCaseId) {
                    const followUpPhrases = /^(yes|no|ok|okay|confirmed|the (results|test|scan|rdt)|it shows|it is|found|got|done|patient|and|also|he|she|they|i|bp|pulse|temp|spo2|\d)/i;
                    const looksLikeNewCase = cleanText.length > 25 && !followUpPhrases.test(cleanText.trim());

                    if (looksLikeNewCase) {
                        // Ask user before proceeding
                        pendingNewCaseConfirm[remoteJid] = {
                            pendingText: cleanText,
                            existingCaseId: activeCaseId,
                            existingCaseRef: activeCaseRef,
                            askedAt: Date.now()
                        };

                        await sock.sendMessage(remoteJid, {
                            text:
                                `📋 *Case Check*\n\n` +
                                `You have an active case open: *${activeCaseRef}*\n\n` +
                                `Is this a continuation of the same case, or a *new patient case*?\n\n` +
                                `Reply:\n` +
                                `*1* — 🆕 New case (closes current)\n` +
                                `*2* — 🔄 Same case (continue)`
                        });
                        return;
                    }
                }

            } catch (caseErr) {
                console.error('[Worker] Case management error (non-fatal):', caseErr.message);
                // Continue without case tracking if it fails
            }

            await dispatchClinicalQuery(remoteJid, user, cleanText, activeCaseId, activeCaseRef);

        } catch (msgErr) {
            console.error('[Worker] General message handling error:', msgErr);
        }
    });
}

// -----------------------------------------------------------------------
// UTILITY: dispatchClinicalQuery
// Sends a clinical query to Core API and delivers the chunked response.
// Extracted so it can be called from both the normal flow and the
// new-case-confirm resolution flow.
// -----------------------------------------------------------------------
async function dispatchClinicalQuery(remoteJid, user, queryText, activeCaseId, activeCaseRef) {
    try {
        const apiRes = await axios.post(
            `${CORE_API_URL}/api/v1/query`,
            {
                user_id: user.id,
                phone: remoteJid,
                prompt: queryText,
                user_name: user.name || '',
                user_role: user.role || 'professional',
                case_id: activeCaseId
            },
            {
                headers: { 'x-secret': INTERNAL_SECRET },
                timeout: 60000
            }
        );

        if (apiRes.data.status === 'insufficient_credits') {
            await sock.sendMessage(remoteJid, { text: apiRes.data.message });
        } else if (apiRes.data.response) {
            // Send chunked response; prepend case reference for context
            const responseText = activeCaseRef
                ? `📁 *Case ${activeCaseRef}*\n\n${apiRes.data.response}`
                : apiRes.data.response;
            await sendChunked(remoteJid, responseText, sock);
        }
    } catch (queryErr) {
        console.error('[Worker] Core API Query error:', queryErr.message);
        await sock.sendMessage(remoteJid, {
            text: '⚠️ *System Notice:* A temporary delay occurred while processing your clinical query. Please re-send.'
        });
    }
}

// -------------------------------------------------------------
// Internal HTTP Endpoint for Payment Confirmation Notifications
// -------------------------------------------------------------
app.get('/health', (req, res) => {
    res.json({ status: 'online', service: 'Tuna AI WhatsApp Gateway', country: 'Uganda' });
});

app.post('/api/v1/internal/send-notification', async (req, res) => {
    const authSecret = req.headers['x-secret'];
    if (authSecret !== INTERNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { whatsappId, message } = req.body;
    if (!whatsappId || !message) {
        return res.status(400).json({ error: 'Missing whatsappId or message' });
    }

    if (sock) {
        try {
            await sock.sendMessage(whatsappId, { text: message });
            return res.json({ success: true });
        } catch (err) {
            console.error('[Worker] Notification delivery error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    } else {
        return res.status(503).json({ error: 'WhatsApp socket not initialized' });
    }
});

// QR Code endpoint — serves the live WhatsApp QR as a PNG image for the admin panel
app.get('/api/v1/internal/qr', async (req, res) => {
    const authSecret = req.headers['x-secret'] || req.query.secret;
    if (authSecret !== INTERNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (waStatus === 'online') {
        return res.json({ status: 'online', message: 'WhatsApp is already connected.' });
    }

    if (!latestQR) {
        return res.json({ status: 'waiting', message: 'QR not yet generated. Please wait or reset the session.' });
    }

    try {
        const QRCode = require('qrcode');
        const pngBuffer = await QRCode.toBuffer(latestQR, { type: 'png', width: 300, margin: 2 });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(pngBuffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Reset session endpoint — clears stale WhatsApp credentials and triggers fresh pairing
app.post('/api/v1/internal/reset-session', (req, res) => {
    const authSecret = req.headers['x-secret'];
    if (authSecret !== INTERNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('[Worker] Manual session reset requested via HTTP.');
    if (sock) {
        try { sock.end(); } catch (_) {}
        sock = null;
    }
    clearSession();
    setTimeout(startWhatsAppWorker, 1000);
    return res.json({ success: true, message: 'Session cleared. Fresh pairing code will appear in logs.' });
});

app.listen(PORT, () => {
    console.log(`[Worker] HTTP server running on port ${PORT}`);
    startWhatsAppWorker();
});
