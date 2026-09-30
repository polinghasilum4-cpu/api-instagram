/**
 * Catbox Upload Endpoint — Anti "Invalid uploader"
 * =================================================
 * Strategi: mimic browser fingerprint persis
 *  1. Fetch homepage dulu → dapet PHPSESSID
 *  2. Set WebKitFormBoundary prefix
 *  3. Selalu kirim field userhash (kosong pun gpp)
 *  4. Full browser headers
 */

const axios = require('axios');
const crypto = require('crypto');

const CATBOX_URL = 'https://catbox.moe/user/api.php';
const CATBOX_HOME = 'https://catbox.moe/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const MAX_SIZE = 200 * 1024 * 1024;

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

// ============================================================
//  STEP 1: Ambil PHPSESSID dari homepage
// ============================================================
async function fetchSession() {
    try {
        const r = await axios.get(CATBOX_HOME, {
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
                'Cache-Control': 'no-cache',
            },
            timeout: 10000,
            validateStatus: () => true,
        });
        const setCookie = r.headers['set-cookie'] || [];
        const phpsessid = setCookie
            .map(c => c.match(/PHPSESSID=([^;]+)/))
            .filter(Boolean)
            .map(m => m[1])[0];
        return phpsessid || null;
    } catch (e) {
        console.log('[catbox] session fetch failed:', e.message);
        return null;
    }
}

// ============================================================
//  STEP 2: Build multipart body manual dengan WebKitFormBoundary
// ============================================================
function buildMultipartBody(buffer, filename, userhash, boundary) {
    const CRLF = '\r\n';
    const parts = [];

    // Field: reqtype
    parts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="reqtype"${CRLF}${CRLF}` +
        `fileupload${CRLF}`
    ));

    // Field: userhash (selalu ada, walau kosong)
    parts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="userhash"${CRLF}${CRLF}` +
        `${userhash || ''}${CRLF}`
    ));

    // Field: fileToUpload (file)
    const safeName = filename.replace(/[\r\n"\\]/g, '_');
    parts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="fileToUpload"; filename="${safeName}"${CRLF}` +
        `Content-Type: application/octet-stream${CRLF}${CRLF}`
    ));
    parts.push(buffer);
    parts.push(Buffer.from(CRLF));

    // Closing boundary
    parts.push(Buffer.from(`--${boundary}--${CRLF}`));

    return Buffer.concat(parts);
}

// ============================================================
//  STEP 3: Upload
// ============================================================
async function uploadToCatbox(buffer, filename, userhash, phpsessid) {
    // Boundary prefix WebKitFormBoundary (kayak browser Chrome)
    const rand = crypto.randomBytes(8).toString('hex');
    const boundary = `----WebKitFormBoundary${rand}`;

    const body = buildMultipartBody(buffer, filename, userhash, boundary);

    const headers = {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,id;q=0.7',
        'Cache-Control': 'no-cache',
        'Origin': 'https://catbox.moe',
        'Referer': 'https://catbox.moe/',
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
        'sec-ch-ua': '"Chromium";v="154", "Not A(Brand";v="99", "Google Chrome";v="154"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'Priority': 'u=1, i',
    };

    if (phpsessid) {
        headers['Cookie'] = `PHPSESSID=${phpsessid}`;
    }

    const r = await axios.post(CATBOX_URL, body, {
        headers,
        timeout: 120000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d) => d],
    });

    return { status: r.status, body: String(r.data || '').trim() };
}

// ============================================================
//  HANDLER
// ============================================================
module.exports = async (req, res) => {
    setupCors(res);

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Hanya POST yang diizinkan');
    }

    console.log('[catbox] incoming request');

    try {
        const url = new URL(req.url, 'https://x');
        let filename = url.searchParams.get('filename') || req.headers['x-filename'] || 'file';
        filename = String(filename).replace(/[^\w\-. ]/g, '_').slice(0, 100) || 'file';

        const buffer = await readRawBody(req);
        if (!buffer || buffer.length === 0) return sendError(res, 400, 'EMPTY_FILE', 'Body kosong');
        if (buffer.length > MAX_SIZE) return sendError(res, 413, 'FILE_TOO_LARGE', `Kebesaran (${buffer.length} bytes)`);

        console.log(`[catbox] file: "${filename}" (${buffer.length} bytes)`);

        // 1. Ambil PHPSESSID
        const phpsessid = await fetchSession();
        console.log('[catbox] PHPSESSID:', phpsessid ? phpsessid.slice(0, 12) + '...' : 'none');

        // 2. Upload dengan userhash kosong + cookie
        const userhash = url.searchParams.get('userhash') || '';

        let upstream;
        try {
            upstream = await uploadToCatbox(buffer, filename, userhash, phpsessid);
        } catch (e) {
            if (e.code === 'ECONNABORTED') return sendError(res, 504, 'UPSTREAM_TIMEOUT', 'Timeout upload ke Catbox');
            return sendError(res, 502, 'UPSTREAM_ERROR', e.message || 'Koneksi ke Catbox gagal');
        }

        console.log(`[catbox] upstream status=${upstream.status} body=${upstream.body.slice(0, 150)}`);

        if (upstream.status !== 200) {
            return sendError(res, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502, 'UPSTREAM_ERROR', `Catbox HTTP ${upstream.status}`, upstream.body);
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
