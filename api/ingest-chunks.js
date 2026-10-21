/**
 * Vercel Serverless Function: Batch Knowledge Chunks Ingestion
 * Receives pre-chunked guideline text from the browser Admin Portal
 * and stores records directly into Supabase medical_knowledge table.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || "https://tormcjsptsstcmsaebsl.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_rNWGdkRSuYcd1nm_58TSjw_mAj6pAoV";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { title, edition = '2023', chunks } = req.body || {};

    if (!title || !chunks || !Array.isArray(chunks) || chunks.length === 0) {
        return res.status(400).json({ error: 'Missing title or chunks array' });
    }

    try {
        const records = chunks.map(c => ({
            document_title: title,
            edition: edition,
            page_number: c.page || 1,
            content: c.content,
            token_count: c.content.split(/\s+/).length
        }));

        const { data, error } = await supabase
            .from('medical_knowledge')
            .insert(records);

        if (error) {
            console.error('[Ingest Chunks Error]', error);
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({
            status: 'success',
            inserted: records.length,
            title: title
        });

    } catch (err) {
        console.error('[Server Error in Ingest Chunks]', err.message);
        return res.status(500).json({ error: err.message });
    }
};
