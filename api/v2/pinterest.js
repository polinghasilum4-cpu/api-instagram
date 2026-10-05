/**
 * Pinterest Downloader — Auto-detect Video/Image
 * ===============================================
 * POST /api/v2/pinterest  {"url": "..."}
 * GET  /api/v2/pinterest?url=<pin_url>
 */

const axios = require('axios');

const PX_BASE = 'https://web--pinsaver-backend--bvs4tz6kpmqp.code.run';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';

const PX_HEADERS = {
    'Origin': 'https://pinsaver.online',
    'Referer': 'https://pinsaver.online/',
    'User-Agent': UA,
    'Accept': '*/*',
};

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
}

function ok(res, data) {
    cors(res);
    return res.status(200).json({ success: true, data });
}

function err(res, msg, status = 400) {
    cors(res);
    return res.status(status).json({ success: false, error: msg });
}

async function callPinSaver(pinUrl, type) {
    const qs = type
        ? `?url=${encodeURIComponent(pinUrl)}&content_type=${type}`
        : `?url=${encodeURIComponent(pinUrl)}`;

    const r = await axios.post(PX_BASE + '/api/download' + qs, null, {
        headers: { ...PX_HEADERS, 'Content-Length': '0' },
        timeout: 30000,
        validateStatus: () => true,
    });

    let data = r.data;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = { raw: data }; }
    }

    return { status: r.status, data };
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') { cors(res); return res.status(204).end(); }

    let pinUrl = req.query.url;

    if (!pinUrl && req.method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        pinUrl = body.url;
    }

    // Health check
    if (!pinUrl) {
        cors(res);
        return res.status(200).json({
            success: true,
            service: 'pinterest-downloader',
            status: 'ok',
            note: 'Auto-detect video/image',
            usage: {
                GET: '/api/v2/pinterest?url=<pin_url>',
                POST: '{"url": "<pin_url>"}',
            },
        });
    }

    if (!/^https?:\/\/(www\.)?(pinterest\.[a-z.]+|pin\.it)\//i.test(pinUrl)) {
        return err(res, 'URL harus Pinterest / pin.it');
    }

    try {
        // ══ Step 1: coba sebagai VIDEO ══
        console.log('[pinterest] 1) try video');
        let r = await callPinSaver(pinUrl, 'video');
        console.log('   →', r.status, JSON.stringify(r.data).slice(0, 200));

        // Cek: apakah sukses atau redirect
        const isRedirect = r.data && r.data.redirect === true;
        const hasData = r.data && !isRedirect && (r.data.url || r.data.video || r.data.image || r.data.medias);

        if (r.status === 200 && hasData) {
            return ok(res, {
                type: 'video',
                source: 'pinsaver',
                ...r.data,
            });
        }

        // ══ Step 2: kalau redirect, coba IMAGE ══
        console.log('[pinterest] 2) try image');
        r = await callPinSaver(pinUrl, 'image');
        console.log('   →', r.status, JSON.stringify(r.data).slice(0, 200));

        const stillRedirect = r.data && r.data.redirect === true;
        const hasImage = r.data && !stillRedirect && (r.data.url || r.data.image);

        if (r.status === 200 && hasImage) {
            return ok(res, {
                type: 'image',
                source: 'pinsaver',
                ...r.data,
            });
        }

        // ══ Step 3: fallback — no content_type ══
        console.log('[pinterest] 3) fallback (no content_type)');
        r = await callPinSaver(pinUrl, null);
        console.log('   →', r.status, JSON.stringify(r.data).slice(0, 200));

        if (r.status === 200 && r.data && !r.data.redirect) {
            return ok(res, {
                type: 'auto',
                source: 'pinsaver',
                ...r.data,
            });
        }

        // ══ Semua gagal ══
        return err(res, `Semua endpoint gagal. Response terakhir: ${JSON.stringify(r.data).slice(0, 200)}`, 502);

    } catch (e) {
        console.error('[pinterest] error:', e.message);
        return err(res, e.message, 502);
    }
};
