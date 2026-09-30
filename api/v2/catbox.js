/* ============================================================
   api/v2/catbox.js — Upload ke catbox.moe
   Endpoint: POST /api/v2/catbox
   Body    : multipart/form-data (field "file")
   Response: { success: true, url: "https://files.catbox.moe/..." }
   ============================================================ */

const axios = require('axios');
const FormData = require('form-data');
const { formidable } = require('formidable');
const fs = require('fs');

const CATBOX_API = 'https://catbox.moe/user/api.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

module.exports.config = {
    api: { bodyParser: false, sizeLimit: '200mb' },
    maxDuration: 60,
};

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'POST only' });
    }

    const startedAt = Date.now();

    try {
        // ============ PARSE MULTIPART ============
        const form = formidable({
            maxFileSize: 200 * 1024 * 1024, // 200 MB
            multiples: false,
        });

        const { files } = await new Promise((resolve, reject) => {
            form.parse(req, (err, fields, files) => {
                if (err) return reject(err);
                resolve({ fields, files });
            });
        });

        const fileField = files.file || files.upload || files.fileToUpload;
        const file = Array.isArray(fileField) ? fileField[0] : fileField;

        if (!file) {
            return res.status(400).json({ success: false, error: 'Field "file" wajib' });
        }

        const buffer = fs.readFileSync(file.filepath);
        const filename = file.originalFilename || 'upload.bin';
        const mimetype = file.mimetype || 'application/octet-stream';

        console.log(`[catbox] uploading ${filename} (${(buffer.length / 1048576).toFixed(2)} MB)`);

        // ============ BUILD FORM-DATA ============
        const catboxForm = new FormData();
        catboxForm.append('reqtype', 'fileupload');
        catboxForm.append('userhash', ''); // empty = anonymous
        catboxForm.append('fileToUpload', buffer, {
            filename: filename,
            contentType: mimetype,
        });

        // ============ UPLOAD ============
        const upstream = await axios.post(CATBOX_API, catboxForm, {
            headers: {
                ...catboxForm.getHeaders(),
                'user-agent': UA,
                'origin': 'https://catbox.moe',
                'referer': 'https://catbox.moe/',
                'accept': '*/*',
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 55000,
            validateStatus: () => true,
        });

        console.log('[catbox] upstream HTTP', upstream.status);

        if (upstream.status !== 200) {
            return res.status(upstream.status).json({
                success: false,
                error: `catbox HTTP ${upstream.status}`,
                raw: String(upstream.data).slice(0, 200),
            });
        }

        // Catbox return plain text URL, contoh: "https://files.catbox.moe/abc123.jpg"
        const url = String(upstream.data).trim();

        if (!url.startsWith('https://files.catbox.moe/') && !url.startsWith('https://litter.catbox.moe/')) {
            return res.status(502).json({
                success: false,
                error: 'Response bukan URL catbox',
                raw: url.slice(0, 200),
            });
        }

        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

        return res.status(200).json({
            success: true,
            url: url,
            filename: filename,
            size: buffer.length,
            elapsed: parseFloat(elapsed),
        });

    } catch (err) {
        console.error('[catbox] error:', err.message);
        const isTimeout = err.code === 'ECONNABORTED';
        return res.status(isTimeout ? 504 : 500).json({
            success: false,
            error: isTimeout ? 'Timeout (55s)' : err.message,
            elapsed: parseFloat(((Date.now() - startedAt) / 1000).toFixed(1)),
        });
    }
};
