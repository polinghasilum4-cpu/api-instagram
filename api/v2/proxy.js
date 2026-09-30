/**
 * Proxy Stream Endpoint — bypass CORS
 * ===================================
 * GET /api/v2/proxy?url=...&filename=...
 * 
 * Dipakai buat force download file dari server yang gak allow CORS.
 */

const axios = require('axios');

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { url, filename } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing "url" parameter' });
    }

    // Sanitize filename
    const safeFilename = String(filename || 'download')
        .replace(/[^\w\-. ]/g, '_')
        .slice(0, 100);

    console.log('[proxy] streaming:', url.slice(0, 100));

    try {
        // Detect referer berdasarkan host
        let referer = 'https://www.tikwm.com/';
        if (url.includes('fbcdn') || url.includes('facebook')) {
            referer = 'https://www.facebook.com/';
        } else if (url.includes('googlevideo') || url.includes('youtube')) {
            referer = 'https://www.youtube.com/';
        } else if (url.includes('cdninstagram') || url.includes('instagram')) {
            referer = 'https://www.instagram.com/';
        } else if (url.includes('tiktok')) {
            referer = 'https://www.tiktok.com/';
        }

        const upstream = await axios.get(url, {
            responseType: 'stream',
            timeout: 120000,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
                'Referer': referer,
                'Accept': '*/*',
                'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            },
        });

        // Forward headers penting
        const ct = upstream.headers['content-type'] || 'application/octet-stream';
        const cl = upstream.headers['content-length'];

        res.setHeader('Content-Type', ct);
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
        res.setHeader('Cache-Control', 'no-cache');
        if (cl) res.setHeader('Content-Length', cl);

        // Pipe stream
        upstream.data.pipe(res);
        
        upstream.data.on('error', (err) => {
            console.error('[proxy] stream error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Stream error' });
            } else {
                res.end();
            }
        });

    } catch (err) {
        console.error('[proxy] error:', err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            error: 'Proxy failed',
            message: err.message,
        });
    }
};
