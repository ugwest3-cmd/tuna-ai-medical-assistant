/**
 * Vercel Serverless Function: Admin Knowledge & Ledger Statistics
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
        const { count: totalChunks } = await supabase.from('medical_knowledge').select('*', { count: 'exact', head: true });
        const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
        const { data: recentOrders } = await supabase.from('payment_orders').select('*').order('created_at', { ascending: false }).limit(5);

        const { data: rawDocs } = await supabase.from('medical_knowledge').select('document_title, edition');
        const docMap = {};
        (rawDocs || []).forEach(r => {
            const title = r.document_title || "Untitled Document";
            const edition = r.edition || "Standard";
            if (!docMap[title]) {
                docMap[title] = { title, edition, chunks: 0 };
            }
            docMap[title].chunks++;
        });

        return res.status(200).json({
            total_chunks: totalChunks || 0,
            total_users: totalUsers || 0,
            documents: Object.values(docMap),
            recent_orders: recentOrders || []
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
