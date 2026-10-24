/**
 * Tuna AI WhatsApp Gateway Worker - Uganda Healthcare Edition
 * Supports:
 * 1. Clinical Queries (Groq Llama-3.3-70B via Core API)
 * 2. Diagnostic Lab & Scan Result Vision (Interprets photos of lab slips, CBCs, RDTs, scans)
 * 3. Mobile Money Top-Ups (PesaPal v3 / UGX)
 * 4. 8-digit Pairing Code support for headless Railway deployments
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
        printQRInTerminal: !PAIRING_NUMBER,
        browser: ['Tuna AI Uganda', 'Chrome', '2.0.0']
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
        const { connection, lastDisconnect } = update;

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
            // 1. Fetch or auto-provision user in Supabase
            let { data: user } = await supabase
                .from('users')
                .select('*')
                .eq('whatsapp_id', remoteJid)
                .single();

            if (!user) {
                console.log(`[Worker] Provisioning new Ugandan health worker: ${remoteJid}`);
                const { data: newUser, error: createErr } = await supabase
                    .from('users')
                    .insert({ whatsapp_id: remoteJid, credit_balance: 20 })
                    .select()
                    .single();

                if (createErr) {
                    console.error('[Worker] User creation error:', createErr);
                    return;
                }

                await supabase.from('credit_transactions').insert({
                    user_id: newUser.id,
                    amount: 20,
                    tx_type: 'trial_grant',
                    notes: 'Initial free trial credits'
                });

                await sock.sendMessage(remoteJid, {
                    text: "🩺 *Welcome to Tuna AI Medical Assistant (Uganda)* 🇺🇬\n\n" +
                          "You have *20 Complimentary Clinical Query Credits*.\n\n" +
                          "• *Clinical Guidance:* Send patient symptoms or condition for step-by-step Uganda Clinical Guidelines (UCG) treatment & dosages.\n" +
                          "• *Lab & Scan Reading:* Send a photo of a lab slip, blood test, RDT strip, or ultrasound report for instant AI interpretation.\n" +
                          "• *Account & Top-Ups:* Reply *BUY* for Mobile Money top-ups.\n\n" +
                          "⚠️ _For healthcare providers, clinical officers, nurses & interns._"
                });
                return;
            }

            if (user.status === 'suspended') {
                await sock.sendMessage(remoteJid, {
                    text: "⛔ Your Tuna AI account is currently suspended. Please contact support."
                });
                return;
            }

            // 2. Handle BUY / Pricing
            if (cleanText.toUpperCase() === "BUY" || cleanText.toUpperCase() === "TOPUP" || cleanText.toUpperCase() === "PRICING") {
                await sock.sendMessage(remoteJid, {
                    text: `💳 *Tuna AI Clinical Top-Up Packages (Uganda)*\n\n` +
                          `Current Balance: *${user.credit_balance} Credits*\n\n` +
                          `Reply with your choice:\n` +
                          `*1* — 100 Credits (10,000 UGX)\n` +
                          `*2* — 300 Credits (25,000 UGX)\n` +
                          `*3* — 1,000 Credits (70,000 UGX)\n\n` +
                          `_Accepted via MTN MoMo, Airtel Money & Visa/Mastercard._`
                });
                return;
            }

            // 3. Handle Package Selection
            if (["1", "2", "3"].includes(cleanText)) {
                await sock.sendMessage(remoteJid, { text: "⏳ Generating your secure PesaPal payment link..." });
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
                        text: `🔗 *Secure PesaPal Checkout:*\n${redirectUrl}\n\n` +
                              `Complete with MTN or Airtel Money. Credits will update automatically!`
                    });
                } catch (orderErr) {
                    console.error('[Worker] Error generating payment link:', orderErr.message);
                    await sock.sendMessage(remoteJid, {
                        text: "❌ Failed to generate checkout link. Please try again in a moment."
                    });
                }
                return;
            }

            // 4. Check Credit Balance
            if (user.credit_balance <= 0) {
                await sock.sendMessage(remoteJid, {
                    text: "⚠️ *Out of Credits*\n\nYou have 0 credits remaining. Please reply *BUY* to replenish your balance."
                });
                return;
            }

            // 5. Handle DIAGNOSTIC LAB / SCAN IMAGE UPLOAD
            if (isImage) {
                await sock.sendMessage(remoteJid, { text: "🔬 *Analyzing laboratory/scan report using Vision AI...*" });
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
                        await sock.sendMessage(remoteJid, { text: labRes.data.response });
                    }
                } catch (imgErr) {
                    console.error('[Worker] Lab interpretation error:', imgErr.message);
                    await sock.sendMessage(remoteJid, {
                        text: "⚠️ *Image Analysis Notice:* Could not clearly read the lab report. Ensure good lighting, lay the slip flat, and take a clear photo."
                    });
                }
                return;
            }

            // 6. Handle TEXT CLINICAL QUERY
            if (!cleanText) return;

            await sock.sendPresenceUpdate('composing', remoteJid);

            try {
                const apiRes = await axios.post(
                    `${CORE_API_URL}/api/v1/query`,
                    {
                        user_id: user.id,
                        phone: remoteJid,
                        prompt: cleanText
                    },
                    {
                        headers: { 'x-secret': INTERNAL_SECRET },
                        timeout: 60000
                    }
                );

                if (apiRes.data.status === 'insufficient_credits') {
                    await sock.sendMessage(remoteJid, { text: apiRes.data.message });
                } else if (apiRes.data.response) {
                    await sock.sendMessage(remoteJid, { text: apiRes.data.response });
                }
            } catch (queryErr) {
                console.error('[Worker] Core API Query error:', queryErr.message);
                await sock.sendMessage(remoteJid, {
                    text: "⚠️ *System Notice:* A temporary delay occurred while processing your clinical query. Please re-send."
                });
            }

        } catch (msgErr) {
            console.error('[Worker] General message handling error:', msgErr);
        }
    });
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
