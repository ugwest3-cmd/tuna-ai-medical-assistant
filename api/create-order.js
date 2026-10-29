/**
 * Vercel Serverless Function: PesaPal v3 Checkout Link Generator
 * Creates pending payment records and generates mobile money checkout links.
 */
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || "https://tormcjsptsstcmsaebsl.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_rNWGdkRSuYcd1nm_58TSjw_mAj6pAoV";
const PESAPAL_ENV = process.env.PESAPAL_ENV || "sandbox";
const PESAPAL_BASE_URL = PESAPAL_ENV.toLowerCase() === "live" 
    ? "https://pay.pesapal.com/v3" 
    : "https://cybqa.pesapal.com/pesapalv3";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TIER_PRICING = {
    "10": { credits: 10, amount: 2000.0, desc: "10 Patient Cases (2,000 UGX)" },
    "50": { credits: 50, amount: 5000.0, desc: "50 Patient Cases (5,000 UGX)" },
    "100": { credits: 100, amount: 10000.0, desc: "100 Patient Cases (10,000 UGX)" },
    "300": { credits: 300, amount: 25000.0, desc: "300 Patient Cases (25,000 UGX)" },
    "1000": { credits: 1000, amount: 70000.0, desc: "1,000 Patient Cases (70,000 UGX)" },
    "1": { credits: 100, amount: 10000.0, desc: "100 Patient Cases (10,000 UGX)" },
    "2": { credits: 300, amount: 25000.0, desc: "300 Patient Cases (25,000 UGX)" },
    "3": { credits: 1000, amount: 70000.0, desc: "1,000 Patient Cases (70,000 UGX)" }
};

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { userId, phone, packageTier } = req.body || {};
    const tier = TIER_PRICING[packageTier];

    if (!userId || !tier) {
        return res.status(400).json({ error: 'Invalid parameters. Required: userId, packageTier (1, 2, or 3).' });
    }

    try {
        // 1. Get PesaPal Auth Token
        const tokenResp = await axios.post(`${PESAPAL_BASE_URL}/api/Auth/RequestToken`, {
            consumer_key: process.env.PESAPAL_CONSUMER_KEY,
            consumer_secret: process.env.PESAPAL_CONSUMER_SECRET
        }, { headers: { 'Content-Type': 'application/json' } });

        const token = tokenResp.data.token;
        const merchantRef = `TUNA-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        const cleanPhone = (phone || "").replace(/[^0-9]/g, '');

        // 2. Submit Order to PesaPal v3
        const orderPayload = {
            id: merchantRef,
            currency: "UGX",
            amount: tier.amount,
            description: `Tuna AI Uganda: ${tier.desc}`,
            callback_url: `${PESAPAL_BASE_URL}/callback`,
            notification_id: process.env.PESAPAL_IPN_ID,
            billing_address: {
                phone_number: cleanPhone || "256700000000",
                email_address: `${cleanPhone || 'user'}@tuna.ai`,
                country_code: "UG",
                first_name: "Uganda",
                last_name: "Doctor"
            }
        };

        const orderResp = await axios.post(
            `${PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`,
            orderPayload,
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        const { order_tracking_id, redirect_url } = orderResp.data;

        // 3. Document Pending Order in Supabase
        await supabase.from('payment_orders').insert({
            user_id: userId,
            pesapal_order_tracking_id: order_tracking_id,
            merchant_reference: merchantRef,
            amount_paid: tier.amount,
            currency: "UGX",
            credits_to_grant: tier.credits,
            status: "PENDING"
        });

        return res.status(200).json({
            merchant_reference: merchantRef,
            order_tracking_id: order_tracking_id,
            redirect_url: redirect_url
        });

    } catch (err) {
        console.error('[Vercel Create Order Error]', err.response?.data || err.message);
        return res.status(500).json({ error: err.response?.data || err.message });
    }
};
