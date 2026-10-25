/**
 * Vercel Serverless Function: Admin Authentication Verification
 */
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { secret } = req.body || {};
    const expectedSecret = process.env.ADMIN_SECRET || 'tuna-admin-uganda-pass';

    if (secret && secret === expectedSecret) {
        return res.status(200).json({ authenticated: true, message: 'Access granted' });
    }

    return res.status(401).json({ error: 'Invalid admin credentials' });
};
