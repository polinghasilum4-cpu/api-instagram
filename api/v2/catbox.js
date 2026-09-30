/**
 * Catbox Upload Endpoint — Vercel Serverless
 * ==========================================
 * POST /api/v2/catbox
 * Body (multipart/form-data):
 *   - file      : File (max 200MB)
 *   - userhash  : (optional) catbox user hash
 * Response: { success: true, url, filename, size }
 */

const axios = require('axios');
const FormData = require('form-data');
const formidable = require('formidable');
const fs = require('fs');

module.exports = async (req, res) => {
    // ============ CORS ============
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    console.log('[catbox] request received');

    try {
        // ============ PARSE MULTIPART ============
        const form = formidable({
            maxFileSize: 200 * 1024 * 1024,
            multiples: false,
            allowEmptyFiles: false,
            keepExtensions: true,
        });

        const [fields, files] = await form.parse(req);

        // Cari file di beberapa field name yang mungkin
        const fileField = files.file || files.fileToUpload || files.image || files.upload;
        const uploadedFile = Array.isArray(fileField) ? fileField[0] : fileField;

        if (!uploadedFile) {
            return res.status(400).json({ success: false, error: 'File tidak ditemukan' });
        }

        const filePath = uploadedFile.filepath || uploadedFile.path;
        const originalName = uploadedFile.originalFilename || uploadedFile.name || 'file';

        const stat = fs.statSync(filePath);
        console.log(`[catbox] file: ${originalName}, size: ${stat.size} bytes`);

        if (stat.size === 0) {
            try { fs.unlinkSync(filePath); } catch (e) {}
            return res.status(400).json({ success: false, error: 'File kosong' });
        }

        if (stat.size > 200 * 1024 * 1024) {
            try { fs.unlinkSync(filePath); } catch (e) {}
            return res.status(413).json({ success: false, error: 'File terlalu besar (>200MB)' });
        }

        // Userhash optional
        const userhash = (fields.userhash && fields.userhash[0]) || '';

        // ============ BUILD FORMDATA ============
        const formData = new FormData();
        formData.append('reqtype', 'fileupload');
        if (userhash) formData.append('userhash', userhash);
        formData.append('fileToUpload', fs.createReadStream(filePath), {
            filename: originalName,
            contentType: uploadedFile.mimetype || 'application/octet-stream',
        });

        // ============ UPLOAD KE CATBOX ============
        console.log('[catbox] uploading...');

        const upstream = await axios.post('https://catbox.moe/user/api.php', formData, {
            headers: {
                ...formData.getHeaders(),
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,id;q=0.7',
                'Cache-Control': 'no-cache',
                'Origin': 'https://catbox.moe',
                'Referer': 'https://catbox.moe/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest',
            },
            timeout: 120000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            validateStatus: () => true,
            responseType: 'text',
            transformResponse: [(d) => d],   // jangan auto-parse
        });

        // Cleanup temp
        try { fs.unlinkSync(filePath); } catch (e) {}

        const resultText = String(upstream.data || '').trim();
        console.log(`[catbox] status=${upstream.status} body=${resultText.slice(0, 200)}`);

        // Catbox return plain text URL atau pesan error
        if (upstream.status !== 200) {
            return res.status(upstream.status).json({
                success: false,
                error: `Catbox HTTP ${upstream.status}`,
                raw: resultText.slice(0, 300),
            });
        }

        if (!resultText.startsWith('http')) {
            return res.status(502).json({
                success: false,
                error: 'Catbox return invalid response',
                raw: resultText.slice(0, 300),
            });
        }

        // ============ SUCCESS ============
        return res.status(200).json({
            success: true,
            url: resultText,
            filename: originalName,
            size: stat.size,
            expires: 'Permanent',
        });

    } catch (err) {
        console.error('[catbox] error:', err.message);

        if (err.code === 'ETOOBIG' || err.message?.includes('maxFileSize')) {
            return res.status(413).json({ success: false, error: 'File terlalu besar (>200MB)' });
        }
        if (err.code === 'ECONNABORTED') {
            return res.status(504).json({ success: false, error: 'Timeout upload ke Catbox' });
        }

        return res.status(500).json({
            success: false,
            error: err.message || 'Upload gagal',
        });
    }
};
