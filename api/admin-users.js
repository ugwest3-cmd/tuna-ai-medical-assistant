/**
 * Vercel Serverless Function: List Registered Users for Admin Portal
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || "https://tormcjsptsstcmsaebsl.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_rNWGdkRSuYcd1nm_58TSjw_mAj6pAoV";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const adminSecret = req.headers['x-admin-secret'];
    const expectedSecret = process.env.ADMIN_SECRET || 'tuna-admin-uganda-pass';
    if (!adminSecret || adminSecret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized: Invalid admin credentials' });
    }

    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, whatsapp_id, name, profession, role, practicing_number, credit_balance, status, onboarding_complete, created_at')
            .order('created_at', { ascending: false })
            .limit(200);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({ users: users || [] });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
