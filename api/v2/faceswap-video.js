/**
 * Video Face Swap — Vercel API
 * =============================
 * POST /api/v2/faceswap-video   → Submit (multipart: video + face)
 * GET  /api/v2/faceswap-video?id=xxx → Cek status
 * GET  /api/v2/faceswap-video   → Health check
 */

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const FormData = require('form-data');
const crypto = require('crypto');
const formidableModule = require('formidable');
const IncomingForm = formidableModule.IncomingForm || formidableModule.default || formidableModule.formidable || formidableModule;

const BASE = 'https://easyfaceswap.com';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
const MAX_FILE = 30 * 1024 * 1024;

const vercelConfig = { api: { bodyParser: false } };
module.exports.config = vercelConfig;

// ── Helpers ──
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
}
const ok = (res, data) => { cors(res); return res.status(200).json({ success: true, data }); };
const err = (res, msg, status = 400, extra = {}) => { cors(res); return res.status(status).json({ success: false, error: msg, ...extra }); };

const newTraceId = () => crypto.randomUUID();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function deepFind(obj, keys, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k];
    for (const v of Object.values(obj)) {
        const f = deepFind(v, keys, depth + 1);
        if (f) return f;
    }
    return null;
}

function parseMultipart(req) {
    return new Promise((resolve, reject) => {
        const form = new IncomingForm({
            maxFileSize: MAX_FILE,
            maxTotalFileSize: MAX_FILE * 2,
            multiples: true,
            keepExtensions: true,
        });
        form.parse(req, (e, fields, files) => {
            if (e) return reject(e);
            resolve({ fields, files });
        });
    });
}

function parseJson(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
        req.on('error', reject);
    });
}

// ── Client ──
class FaceSwap {
    constructor() {
        this.jar = new CookieJar();
        this.http = wrapper(axios.create({
            jar: this.jar,
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Origin': BASE,
                'Referer': `${BASE}/video-face-swap/`,
            },
            validateStatus: () => true,
            timeout: 60000,
        }));
    }

    async run(videoBuffer, faceBuffer) {
        // 0. Warm-up
        await this.http.get(`${BASE}/video-face-swap/`);

        // 1. Device session
        const sessRes = await this.http.get(`${BASE}/api/device/session`, {
            headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': newTraceId() },
        });
        const deviceId = deepFind(sessRes.data, ['anonymousDeviceId']);
        if (!deviceId) throw new Error('No deviceId');
        await this.jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);

        // 2. Upload sign
        const videoFilename = crypto.randomBytes(50).toString('base64url') + '.mp4';
        const faceFilename = 'face_' + Date.now() + '.jpg';

        const signUpRes = await this.http.post(`${BASE}/api/face-video/upload-sign`, {
            functionTag: 'videofaceswap',
            files: [
                { filename: videoFilename, contentType: 'video/mp4', size: videoBuffer.length },
                { filename: faceFilename, contentType: 'image/jpeg', size: faceBuffer.length },
            ],
        }, {
            headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': newTraceId() },
        });
        const uploads = deepFind(signUpRes.data, ['uploads']) || [];
        if (uploads.length < 2) throw new Error('No upload URLs');

        const videoUp = uploads[0];
        const faceUp = uploads[1];

        // 3. Upload ke S3
        await axios.put(videoUp.uploadUrl, videoBuffer, {
            headers: { 'Content-Type': 'video/mp4', 'Content-Length': videoBuffer.length },
            timeout: 120000, maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: () => true,
        });
        await axios.put(faceUp.uploadUrl, faceBuffer, {
            headers: { 'Content-Type': 'image/jpeg', 'Content-Length': faceBuffer.length },
            timeout: 120000, maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: () => true,
        });

        // 4. Authorize
        const authRes = await this.http.post(`${BASE}/api/face-video/authorize`, {
            anonymousDeviceId: deviceId,
            requestId: crypto.randomUUID(),
        }, {
            headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': newTraceId(), 'x-anonymous-device-id': deviceId },
        });
        const ticket = deepFind(authRes.data, ['ticket']);
        if (!ticket) throw new Error('No ticket');

        // 5. UUID
        const uuidRes = await this.http.post(`${BASE}/api/face-video/uuid`,
            { functionTag: 'videofaceswap' },
            { headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': newTraceId(), 'x-anonymous-ticket': ticket, 'x-anonymous-device-id': deviceId } }
        );
        const uId = typeof uuidRes.data === 'string' ? uuidRes.data : deepFind(uuidRes.data, ['uId']);
        if (!uId) throw new Error('No uId');

        // 6. Sign
        const signRes = await this.http.post(`${BASE}/api/face-video/sign`, {
            modelfile: videoUp.cdnUrl, imagefile: [faceUp.cdnUrl], imagefile2: [],
            priority: '1', uId, aiFunAction: 'videofaceswap', platFormId: '',
            check: '0', pointId: deviceId, consumeType: 'Customizeswapvideo', requestType: '1',
        }, {
            headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': newTraceId(), 'x-anonymous-ticket': ticket, 'x-anonymous-device-id': deviceId },
        });
        const decrypt = deepFind(signRes.data, ['decrypt']);
        const signHash = deepFind(signRes.data, ['sign']);
        if (!decrypt || !signHash) throw new Error('No decrypt/sign');

        // 7. Submit (attempt A — CONFIRMED WORKS)
        const fd = new FormData();
        fd.append('decrypt', decrypt);
        fd.append('pkgName', 'com.enjoy.facejoy.web');
        fd.append('sign', signHash);
        fd.append('content', JSON.stringify({ enhancerEnable: false }));
        fd.append('uId', uId);
        fd.append('version', '3');
        fd.append('anonymousDeviceId', deviceId);
        fd.append('uuId', deviceId);
        fd.append('pointId', deviceId);

        const submitRes = await this.http.post(`${BASE}/api/face-video/submit`, fd, {
            headers: {
                ...fd.getHeaders(),
                'x-workbench-kind': 'face-video',
                'x-workbench-trace-id': newTraceId(),
                'x-anonymous-ticket': ticket,
                'x-anonymous-device-id': deviceId,
                'Accept': '*/*',
            },
        });
        const obtainKey = deepFind(submitRes.data, ['obtainKey']);
        if (!obtainKey) throw new Error(`Submit failed: ${JSON.stringify(submitRes.data)}`);

        // 8. Polling (max 45s di serverless)
        for (let i = 0; i < 9; i++) {
            await sleep(5000);
            const rRes = await this.http.post(`${BASE}/api/face-video/result`,
                { obtainKey },
                { headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': newTraceId(), 'x-anonymous-ticket': ticket, 'x-anonymous-device-id': deviceId } }
            );
            const url = deepFind(rRes.data, ['url', 'videoUrl', 'resultUrl']);
            const state = deepFind(rRes.data, ['state', 'status']);
            if (url) return { url, state, obtainKey, uId };
            if (state === 'failed' || state === 'error') throw new Error('Task failed');
        }

        // Belum selesai — return obtainKey biar client bisa poll
        return { url: null, state: 'processing', obtainKey, uId };
    }

    async checkStatus(obtainKey) {
        const r = await this.http.post(`${BASE}/api/face-video/result`,
            { obtainKey },
            { headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': newTraceId() } }
        );
        return r.data;
    }
}

// ── Handler ──
module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') { cors(res); return res.status(204).end(); }

    if (req.method === 'GET') {
        if (req.query.id) {
            try {
                const result = await new FaceSwap().checkStatus(req.query.id);
                return ok(res, result);
            } catch (e) { return err(res, e.message, 500); }
        }
        return ok(res, {
            service: 'video-face-swap',
            status: 'ok',
            usage: {
                'POST multipart': 'video + face files',
                'POST json': '{"videoUrl": "...", "faceUrl": "..."}',
                'GET': '/api/v2/faceswap-video?id=<obtainKey>',
            },
            limits: { maxFileSize: `${MAX_FILE / 1024 / 1024} MB` },
        });
    }

    if (req.method !== 'POST') return err(res, 'Method not allowed', 405);

    const t0 = Date.now();

    try {
        let videoBuffer, faceBuffer;
        const ct = req.headers['content-type'] || '';

        if (ct.includes('multipart/form-data')) {
            const { files } = await parseMultipart(req);
            const map = {};
            for (const k of Object.keys(files || {})) {
                const f = Array.isArray(files[k]) ? files[k][0] : files[k];
                map[k.toLowerCase()] = f;
            }
            const vF = map['video'] || map['modelfile'] || map['source'];
            const fF = map['face'] || map['image'] || map['target'];
            if (!vF || !fF) return err(res, 'Wajib upload "video" dan "face"', 400);

            videoBuffer = require('fs').readFileSync(vF.filepath);
            faceBuffer = require('fs').readFileSync(fF.filepath);
            try { require('fs').unlinkSync(vF.filepath); } catch {}
            try { require('fs').unlinkSync(fF.filepath); } catch {}
        } else if (ct.includes('application/json')) {
            const body = await parseJson(req);
            const vUrl = body.videoUrl || body.video;
            const fUrl = body.faceUrl || body.face;
            if (!vUrl || !fUrl) return err(res, 'Body butuh "videoUrl" dan "faceUrl"', 400);

            const [vr, fr] = await Promise.all([
                axios.get(vUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: MAX_FILE, validateStatus: () => true }),
                axios.get(fUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: MAX_FILE, validateStatus: () => true }),
            ]);
            if (vr.status !== 200) return err(res, `Fetch video HTTP ${vr.status}`, 502);
            if (fr.status !== 200) return err(res, `Fetch face HTTP ${fr.status}`, 502);

            videoBuffer = Buffer.from(vr.data);
            faceBuffer = Buffer.from(fr.data);
        } else {
            return err(res, 'Content-Type harus multipart/form-data atau application/json', 415);
        }

        if (videoBuffer.length > MAX_FILE || faceBuffer.length > MAX_FILE) {
            return err(res, `File max ${MAX_FILE / 1024 / 1024} MB`, 413);
        }

        const result = await new FaceSwap().run(videoBuffer, faceBuffer);

        return ok(res, {
            url: result.url,
            status: result.url ? 'done' : result.state,
            obtainKey: result.obtainKey,
            statusUrl: result.url ? null : `/api/v2/faceswap-video?id=${result.obtainKey}`,
            elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
        });

    } catch (e) {
        console.error('[faceswap]', e.message);
        return err(res, e.message, 500, { elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s` });
    }
};
