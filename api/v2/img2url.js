// language: JavaScript (Node 20, Vercel), file: api/v2/img2url.js
/**
 * Image/File → URL
 * POST /api/v2/img2url
 * multipart/form-data, field: fileToUpload
 *
 * Default upstream: catbox.moe
 * Kalau kena 412 (Vercel sin1 diblokir catbox), set env UPLOAD_TARGET=0x0
 * untuk pakai 0x0.st — gratis, gak blokir datacenter, retensi 365 hari.
 */

const axios = require('axios');
const FormData = require('form-data');
const { formidable } = require('formidable');
const fs = require('fs');

const CONFIG = {
    MAX_FILE_SIZE: 200 * 1024 * 1024,
    TIMEOUT: 120000,
    UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ACCEPTED_FIELDS: ['fileToUpload', 'file', 'image', 'upload'],
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

// ---------- Upstream targets ----------
const UPSTREAM = process.env.UPLOAD_TARGET || 'catbox';

const TARGETS = {
    catbox: {
        url: 'https://catbox.moe/user/api.php',
        field: 'fileToUpload',
        extra: { reqtype: 'fileupload', userhash: '' },
        headers: (fd) => ({
            ...fd.getHeaders(),
            'Origin': 'https://catbox.moe',
            'Referer': 'https://catbox.moe/',
            'User-Agent': CONFIG.UA,
            'X-Requested-With': 'XMLHttpRequest',
        }),
        expires: 'Permanent',
    },
    '0x0': {
        url: 'https://0x0.st',
        field: 'file',
        extra: {},
        headers: (fd) => ({
            ...fd.getHeaders(),
            'User-Agent': CONFIG.UA,
        }),
        expires: '365d',
    },
};

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Requested-With');
}

// ---------- Upload ----------
async function upload(tempPath, filename, mimetype) {
    const target = TARGETS[UPSTREAM];
    if (!target) throw new Error(`UPLOAD_TARGET tidak dikenal: ${UPSTREAM}`);

    const fd = new FormData();
    for (const [k, v] of Object.entries(target.extra)) fd.append(k, v);
    fd.append(target.field, fs.createReadStream(tempPath), {
        filename,
        contentType: mimetype || 'application/octet-stream',
    });

    const res = await axios.post(target.url, fd, {
        headers: target.headers(fd),
        timeout: CONFIG.TIMEOUT,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d) => d],
    });

    return { status: res.status, body: String(res.data || '').trim(), expires: target.expires, source: UPSTREAM };
}

// ---------- Handler ----------
module.exports = async (req, res) => {
    setupCors(res);

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
        return sendError(res, 405, ERR.METHOD_NOT_ALLOWED, 'Hanya POST yang diizinkan');
    }

    console.log(`[img2url] upstream=${UPSTREAM} | request masuk`);
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

        console.log(`[img2url] upload "${originalName}" (${stat.size} bytes) → ${UPSTREAM}`);

        let upstream;
        try {
            upstream = await upload(tempPath, originalName, mimetype);
        } catch (e) {
            if (e.code === 'ECONNABORTED') return sendError(res, 504, ERR.UPSTREAM_TIMEOUT, 'Timeout upload');
            return sendError(res, 502, ERR.UPSTREAM_ERROR, e.message || 'Koneksi ke upstream gagal');
        }

        console.log(`[img2url] status=${upstream.status} body=${upstream.body.slice(0, 150)}`);

        // 412 khusus catbox — Vercel sin1 diblokir
        if (upstream.status === 412 && UPSTREAM === 'catbox') {
            return sendError(
                res,
                412,
                ERR.UPSTREAM_ERROR,
                'Catbox tolak IP Vercel sin1. Set env UPLOAD_TARGET=0x0 di Vercel → Settings → Environment Variables, redeploy.',
                upstream.body
            );
        }

        if (upstream.status !== 200) {
            return sendError(
                res,
                upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
                ERR.UPSTREAM_ERROR,
                `Upstream HTTP ${upstream.status}`,
                upstream.body
            );
        }

        if (!/^https?:\/\//i.test(upstream.body)) {
            return sendError(res, 502, ERR.UPSTREAM_INVALID, 'Upstream tidak return URL valid', upstream.body);
        }

        return sendJSON(res, 200, {
            ok: true,
            data: {
                url: upstream.body,
                filename: originalName,
                size: stat.size,
                mimetype,
                source: upstream.source,
                expires: upstream.expires,
            },
        });

    } catch (err) {
        console.error('[img2url] fatal:', err.message, err.stack);
        return sendError(res, 500, ERR.INTERNAL, err.message || 'Internal server error');
    } finally {
        safeUnlink(tempPath);
    }
};
