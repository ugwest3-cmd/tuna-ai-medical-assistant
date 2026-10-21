/**
 * Vercel Serverless Function: PesaPal v3 IPN Webhook Engine
 * Handles instant payment notifications, verifies status, and fulfills credits.
 */
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL || "https://tormcjsptsstcmsaebsl.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_rNWGdkRSuYcd1nm_58TSjw_mAj6pAoV";
const PESAPAL_ENV = process.env.PESAPAL_ENV || "sandbox";
const PESAPAL_BASE_URL = PESAPAL_ENV.toLowerCase() === "live" 
    ? "https://pay.pesapal.com/v3" 
    : "https://cybqa.pesapal.com/pesapalv3";

const WHATSAPP_WORKER_URL = process.env.WHATSAPP_WORKER_URL || process.env.RAILWAY_WHATSAPP_WORKER_URL;
const INTERNAL_SECRET = process.env.INTERNAL_GATEWAY_SECRET || "tuna-ai-uganda-secret-2026";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

module.exports = async (req, res) => {
    // Handle both GET and POST requests from PesaPal
    const query = req.query || {};
    const body = req.body || {};

    const orderTrackingId = query.OrderTrackingId || body.OrderTrackingId;
    const merchantReference = query.OrderMerchantReference || query.MerchantReference || body.MerchantReference;
    const notificationType = query.OrderNotificationType || body.NotificationType || "IPNCHANGE";

    if (!orderTrackingId || !merchantReference) {
        return res.status(200).json({ status: "ignored", reason: "Missing OrderTrackingId or MerchantReference" });
    }

    try {
        // 1. Request PesaPal Auth Token
        const tokenResp = await axios.post(`${PESAPAL_BASE_URL}/api/Auth/RequestToken`, {
            consumer_key: process.env.PESAPAL_CONSUMER_KEY,
            consumer_secret: process.env.PESAPAL_CONSUMER_SECRET
        }, { headers: { 'Content-Type': 'application/json' } });

        const token = tokenResp.data.token;

        // 2. Fetch Transaction Payment Status
        const statusResp = await axios.get(
            `${PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const txData = statusResp.data;
        const paymentStatus = (txData.payment_status_description || "").toUpperCase();

        if (paymentStatus === "COMPLETED") {
            // Find order in Supabase
            const { data: order, error: orderErr } = await supabase
                .from('payment_orders')
                .select('*')
                .eq('merchant_reference', merchantReference)
                .single();

            if (order && order.status === 'PENDING') {
                const userId = order.user_id;
                const credits = order.credits_to_grant;

                // A. Update payment order status
                await supabase
                    .from('payment_orders')
                    .update({ status: 'COMPLETED', raw_ipn_response: txData, updated_at: new Date() })
                    .eq('id', order.id);

                // B. Increment credits atomically using Supabase stored procedure
                await supabase.rpc('increment_user_credits', {
                    user_uuid: userId,
                    amount_to_add: credits
                });

                // C. Document in credit transactions ledger
                await supabase.from('credit_transactions').insert({
                    user_id: userId,
                    amount: credits,
                    tx_type: 'purchase',
                    notes: `PesaPal Order ${orderTrackingId} (${order.amount_paid} UGX)`
                });

                // D. Notify WhatsApp Worker to send instant confirmation
                if (WHATSAPP_WORKER_URL) {
                    const { data: user } = await supabase.from('users').select('whatsapp_id').eq('id', userId).single();
                    if (user && user.whatsapp_id) {
                        try {
                            await axios.post(`${WHATSAPP_WORKER_URL}/api/v1/internal/send-notification`, {
                                whatsappId: user.whatsapp_id,
                                message: `✅ *Payment Confirmed!* +${credits} Clinical Credits have been credited to your Tuna AI balance.`
                            }, {
                                headers: { 'x-secret': INTERNAL_SECRET },
                                timeout: 10000
                            });
                        } catch (notifyErr) {
                            console.error('[Vercel IPN] WhatsApp notification warning:', notifyErr.message);
                        }
                    }
                }

                console.log(`[Vercel IPN] Granted ${credits} credits to user ${userId}`);
            }
        }

        // Return exact response required by PesaPal v3
        return res.status(200).json({
            orderNotificationType: notificationType,
            orderTrackingId: orderTrackingId,
            orderMerchantReference: merchantReference,
            status: 200
        });

    } catch (err) {
        console.error('[Vercel IPN Error]', err.message);
        return res.status(500).json({ error: err.message });
    }
};
