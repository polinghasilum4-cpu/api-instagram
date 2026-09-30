// language: JavaScript (Node 20, Vercel), file: api/v2/catbox.js
/**
 * Catbox Upload Endpoint
 * ======================
 * POST /api/v2/catbox
 * Fix: formidable v3 named export, session prime anti-412, litterbox fallback.
 */

const axios = require('axios');
const FormData = require('form-data');
const { formidable } = require('formidable');   // ← v3: named export
const fs = require('fs');

const CONFIG = {
    MAX_FILE_SIZE: 200 * 1024 * 1024,
    UPLOAD_TIMEOUT: 120000,
    CATBOX_URL: 'https://catbox.moe/user/api.php',
    LITTERBOX_URL: 'https://litterbox.catbox.moe/resources/internals/api.php',
    LITTERBOX_EXPIRY: '72h',
    // UA Chrome riil & terkini. Update tiap kuartal.
    UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ACCEPTED_FIELDS: ['file', 'fileToUpload', 'image', 'upload'],
    SESSION_TTL: 5 * 60 * 1000,
};

const ERR = {
    METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
    NO_FILE: 'NO_FILE',
    EMPTY_FILE: 'EMPTY_FILE',
    FILE_TOO_LARGE: 'FILE_TOO_LARGE',
    PARSE_ERROR: 'PARSE_ERROR',
    UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
    UPSTREAM_ERROR: 'UPSTREAM_ERROR',
    UPSTREAM_INVALID: 'UPSTREAM_INVALID',
    INTERNAL: 'INTERNAL',
};

// ---------- Session cache (cookie cf_clearance / session catbox) ----------
let sessionCookie = null;
let sessionAt = 0;

async function primeCatboxSession() {
    const now = Date.now();
    if (sessionCookie && (now - sessionAt) < CONFIG.SESSION_TTL) return sessionCookie;

    try {
        const r = await fetch('https://catbox.moe/', {
            headers: {
                'user-agent': CONFIG.UA,
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
            },
            signal: AbortSignal.timeout(8000),
        });

        const setCookies = typeof r.headers.getSetCookie === 'function'
            ? r.headers.getSetCookie()
            : [r.headers.get('set-cookie')].filter(Boolean);

        sessionCookie = setCookies
            .map(c => c.split(';')[0].trim())
            .filter(Boolean)
            .join('; ');

        sessionAt = now;
        console.log('[catbox] session primed:', sessionCookie.slice(0, 80) || '(kosong)');
    } catch (e) {
        console.warn('[catbox] prime gagal:', e.message);
        sessionCookie = null;
    }
    return sessionCookie;
}

// ---------- Helpers ----------
function sendJSON(res, status, payload) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).json(payload);
}

function sendError(res, status, code, message, raw) {
    const payload = { ok: false, error: { code, message } };
    if (raw) payload.error.raw = String(raw).slice(0, 300);
    return sendJSON(res, status, payload);
}

function safeUnlink(p) {
    if (!p) return;
    try { fs.unlinkSync(p); } catch (_) {}
}

function pickUploadedFile(files) {
    for (const field of CONFIG.ACCEPTED_FIELDS) {
        const val = files[field];
        if (!val) continue;
        const f = Array.isArray(val) ? val[0] : val;
        if (f) return f;
    }
    return null;
}

function setupCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
}

// ---------- Catbox upload (dengan cookie) ----------
async function uploadToCatbox(filePath, filename, mimetype, userhash, cookie) {
    const fd = new FormData();
    fd.append('reqtype', 'fileupload');
    if (userhash) fd.append('userhash', userhash);
    fd.append('fileToUpload', fs.createReadStream(filePath), {
        filename,
        contentType: mimetype || 'application/octet-stream',
    });

    const headers = {
        ...fd.getHeaders(),
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://catbox.moe',
        'Referer': 'https://catbox.moe/',
        'User-Agent': CONFIG.UA,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
    };
    if (cookie) headers['Cookie'] = cookie;

    const res = await axios.post(CONFIG.CATBOX_URL, fd, {
        headers,
        timeout: CONFIG.UPLOAD_TIMEOUT,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d) => d],
    });

    return { status: res.status, body: String(res.data || '').trim() };
}

// ---------- Litterbox fallback (host sementara, lebih toleran) ----------
async function uploadToLitterbox(filePath, filename, mimetype) {
    const fd = new FormData();
    fd.append('reqtype', 'fileupload');
    fd.append('time', CONFIG.LITTERBOX_EXPIRY);
    fd.append('fileToUpload', fs.createReadStream(filePath), {
        filename,
        contentType: mimetype || 'application/octet-stream',
    });

    const res = await axios.post(CONFIG.LITTERBOX_URL, fd, {
        headers: { ...fd.getHeaders(), 'User-Agent': CONFIG.UA },
        timeout: CONFIG.UPLOAD_TIMEOUT,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d) => d],
    });

    return { status: res.status, body: String(res.data || '').trim() };
}

// ---------- Handler ----------
module.exports = async (req, res) => {
    setupCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
        return sendError(res, 405, ERR.METHOD_NOT_ALLOWED, 'Hanya POST yang diizinkan');
    }

    console.log('[catbox] incoming request');
    let tempPath = null;

    try {
        const form = formidable({
            maxFileSize: CONFIG.MAX_FILE_SIZE,
            multiples: false,
            allowEmptyFiles: false,
            keepExtensions: true,
        });

        let fields, files;
        try {
            [fields, files] = await form.parse(req);
        } catch (e) {
            const isTooBig = e.code === 'ETOOBIG' || /maxFileSize/i.test(e.message || '');
            return sendError(
                res,
                isTooBig ? 413 : 400,
                isTooBig ? ERR.FILE_TOO_LARGE : ERR.PARSE_ERROR,
                isTooBig ? 'File terlalu besar (>200MB)' : 'Gagal parse form: ' + e.message
            );
        }

        const uploaded = pickUploadedFile(files);
        if (!uploaded) {
            return sendError(res, 400, ERR.NO_FILE, 'File tidak ditemukan. Kirim multipart/form-data dengan field fileToUpload.');
        }

        // v3 pakai .filepath & .originalFilename
        tempPath = uploaded.filepath || uploaded.path;
        const originalName = uploaded.originalFilename || uploaded.name || 'file';
        const mimetype = uploaded.mimetype || 'application/octet-stream';

        let stat;
        try { stat = fs.statSync(tempPath); }
        catch { return sendError(res, 400, ERR.PARSE_ERROR, 'File temp tidak bisa dibaca'); }

        if (stat.size === 0) return sendError(res, 400, ERR.EMPTY_FILE, 'File kosong');
        if (stat.size > CONFIG.MAX_FILE_SIZE) {
            return sendError(res, 413, ERR.FILE_TOO_LARGE, `File terlalu besar (${stat.size} bytes)`);
        }

        const userhash = (fields.userhash && fields.userhash[0]) || '';
        console.log(`[catbox] upload "${originalName}" (${stat.size} bytes)`);

        // Prime session supaya gak kena 412
        const cookie = await primeCatboxSession();

        let upstream;
        try {
            upstream = await uploadToCatbox(tempPath, originalName, mimetype, userhash, cookie);
        } catch (e) {
            if (e.code === 'ECONNABORTED') {
                return sendError(res, 504, ERR.UPSTREAM_TIMEOUT, 'Timeout upload ke Catbox');
            }
            return sendError(res, 502, ERR.UPSTREAM_ERROR, e.message || 'Koneksi ke Catbox gagal');
        }

        console.log(`[catbox] upstream status=${upstream.status} body=${upstream.body.slice(0, 150)}`);

        // 412 = anti-abuse. Retry sekali dengan session fresh.
        if (upstream.status === 412) {
            console.log('[catbox] 412, retry dengan session baru');
            sessionCookie = null; sessionAt = 0;
            const fresh = await primeCatboxSession();
            try {
                upstream = await uploadToCatbox(tempPath, originalName, mimetype, userhash, fresh);
                console.log(`[catbox] retry status=${upstream.status}`);
            } catch (_) {}
        }

        // Masih gagal → litterbox fallback
        let source = 'catbox';
        if (upstream.status !== 200 || !/^https?:\/\//i.test(upstream.body)) {
            console.log(`[catbox] primary gagal (${upstream.status}), coba litterbox`);
            try {
                const lb = await uploadToLitterbox(tempPath, originalName, mimetype);
                if (lb.status === 200 && /^https?:\/\//i.test(lb.body)) {
                    upstream = lb;
                    source = 'litterbox';
                    console.log('[catbox] litterbox OK:', lb.body);
                }
            } catch (e) {
                console.warn('[catbox] litterbox gagal:', e.message);
            }
        }

        if (upstream.status !== 200) {
            return sendError(
                res,
                upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
                ERR.UPSTREAM_ERROR,
                `Uploader HTTP ${upstream.status}`,
                upstream.body
            );
        }

        if (!/^https?:\/\//i.test(upstream.body)) {
            return sendError(res, 502, ERR.UPSTREAM_INVALID, 'Uploader tidak return URL valid', upstream.body);
        }

        return sendJSON(res, 200, {
            ok: true,
            data: {
                url: upstream.body,
                filename: originalName,
                size: stat.size,
                mimetype,
                source,
                expires: source === 'litterbox' ? CONFIG.LITTERBOX_EXPIRY : 'Permanent',
            },
        });

    } catch (err) {
        console.error('[catbox] fatal:', err.message, err.stack);
        return sendError(res, 500, ERR.INTERNAL, err.message || 'Internal server error');
    } finally {
        safeUnlink(tempPath);
    }
};
