/**
 * Catbox Upload Endpoint — Raw Binary Mode
 * =========================================
 * POST /api/v2/catbox?filename=test.jpg
 * Body: raw binary (application/octet-stream)
 * 
 * Tidak pakai formidable (gak compatible dengan Vercel serverless)
 */

const axios = require('axios');
const FormData = require('form-data');

const CATBOX_URL = 'https://catbox.moe/user/api.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const MAX_SIZE = 200 * 1024 * 1024;
const UPLOAD_TIMEOUT = 120000;

function sendJSON(res, status, payload) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).json(payload);
}

function sendError(res, status, code, message, raw) {
    const payload = { ok: false, error: { code, message } };
    if (raw) payload.error.raw = String(raw).slice(0, 300);
    return sendJSON(res, status, payload);
}

function setupCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Requested-With');
}

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function uploadToCatbox(buffer, filename) {
    const fd = new FormData();
    fd.append('reqtype', 'fileupload');
    fd.append('fileToUpload', buffer, { filename });

    const r = await axios.post(CATBOX_URL, fd, {
        headers: {
            ...fd.getHeaders(),
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,id;q=0.7',
            'Cache-Control': 'no-cache',
            'Origin': 'https://catbox.moe',
            'Referer': 'https://catbox.moe/',
            'User-Agent': UA,
            'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: UPLOAD_TIMEOUT,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d) => d],
    });

    return { status: r.status, body: String(r.data || '').trim() };
}

module.exports = async (req, res) => {
    setupCors(res);

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Hanya POST yang diizinkan');
    }

    console.log('[catbox] incoming request');
    console.log('[catbox] content-type:', req.headers['content-type']);
    console.log('[catbox] content-length:', req.headers['content-length']);

    try {
        // Ambil filename dari query atau header
        const url = new URL(req.url, 'https://x');
        let filename = url.searchParams.get('filename') || req.headers['x-filename'] || 'file';
        filename = String(filename).replace(/[^\w\-. ]/g, '_').slice(0, 100) || 'file';

        // Baca raw binary body
        const buffer = await readRawBody(req);

        if (!buffer || buffer.length === 0) {
            return sendError(res, 400, 'EMPTY_FILE', 'Body kosong');
        }
        if (buffer.length > MAX_SIZE) {
            return sendError(res, 413, 'FILE_TOO_LARGE', `File terlalu besar (${buffer.length} bytes)`);
        }

        console.log(`[catbox] uploading "${filename}" (${buffer.length} bytes)`);

        let upstream;
        try {
            upstream = await uploadToCatbox(buffer, filename);
        } catch (e) {
            if (e.code === 'ECONNABORTED') {
                return sendError(res, 504, 'UPSTREAM_TIMEOUT', 'Timeout upload ke Catbox');
            }
            return sendError(res, 502, 'UPSTREAM_ERROR', e.message || 'Koneksi ke Catbox gagal');
        }

        console.log(`[catbox] upstream status=${upstream.status} body=${upstream.body.slice(0, 150)}`);

        if (upstream.status !== 200) {
            return sendError(
                res,
                upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
                'UPSTREAM_ERROR',
                `Catbox HTTP ${upstream.status}`,
                upstream.body
            );
        }

        if (!/^https?:\/\//i.test(upstream.body)) {
            return sendError(res, 502, 'UPSTREAM_INVALID', 'Catbox tidak return URL valid', upstream.body);
        }

        return sendJSON(res, 200, {
            ok: true,
            data: {
                url: upstream.body,
                filename,
                size: buffer.length,
                expires: 'Permanent',
            },
        });

    } catch (err) {
        console.error('[catbox] fatal:', err.message, err.stack);
        return sendError(res, 500, 'INTERNAL', err.message || 'Internal server error');
    }
};
