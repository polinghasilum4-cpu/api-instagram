/**
 * Video Face Swap — Vercel API
 * =============================
 * POST /api/v2/faceswap-video           → Submit (multipart atau JSON with URLs)
 * GET  /api/v2/faceswap-video?id=xxx    → Cek status by obtainKey
 * GET  /api/v2/faceswap-video           → Health check
 *
 * ENV (opsional, recommended):
 *   FJ_DEVICE=facejoy-web-xxx.yyy
 *     → Pakai device dari browser (kalau device baru gak dapet ticket)
 */

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const FormData = require('form-data');
const crypto = require('crypto');
const formidableModule = require('formidable');
const IncomingForm =
    formidableModule.IncomingForm ||
    formidableModule.default ||
    formidableModule.formidable ||
    formidableModule;

const BASE = 'https://easyfaceswap.com';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
const MAX_FILE = 30 * 1024 * 1024; // 30 MB

const vercelConfig = { api: { bodyParser: false } };
module.exports.config = vercelConfig;


// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════
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
function err(res, msg, status = 400, extra = {}) {
    cors(res);
    return res.status(status).json({ success: false, error: msg, ...extra });
}

const newTraceId = () => crypto.randomUUID();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function deepFind(obj, keys, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    for (const k of keys) {
        if (obj[k] != null && obj[k] !== '') return obj[k];
    }
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
        req.on('data', c => {
            data += c;
            if (data.length > 1e6) req.destroy();
        });
        req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
        });
        req.on('error', reject);
    });
}


// ══════════════════════════════════════════════════════════════════════
// FaceSwap Client
// ══════════════════════════════════════════════════════════════════════
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

    // ── 1. Dapat device ID (dari ENV atau server) ──
    async getDeviceId() {
        const envDevice = process.env.FJ_DEVICE;

        if (envDevice && envDevice.startsWith('facejoy-')) {
            console.log('[faceswap] using ENV device:', envDevice.slice(0, 40));
            await this.jar.setCookie(
                `fj_device=${envDevice}; Path=/; Domain=.easyfaceswap.com`,
                BASE
            );
            return envDevice;
        }

        console.log('[faceswap] requesting fresh device from server...');
        const sessRes = await this.http.get(`${BASE}/api/device/session`, {
            headers: {
                'x-workbench-kind': 'face-video',
                'x-workbench-trace-id': newTraceId(),
            },
        });

        const deviceId = deepFind(sessRes.data, ['anonymousDeviceId', 'deviceId']);
        if (!deviceId) {
            throw new Error(`No deviceId in session response: ${JSON.stringify(sessRes.data).slice(0, 200)}`);
        }

        console.log('[faceswap] fresh device:', deviceId.slice(0, 40));
        await this.jar.setCookie(
            `fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`,
            BASE
        );
        return deviceId;
    }

    // ── 2. Authorize → ticket ──
    async authorize(deviceId) {
        // Retry beberapa kali dengan delay (device baru butuh waktu)
        const maxRetries = 3;
        for (let i = 0; i < maxRetries; i++) {
            if (i > 0) {
                console.log(`[faceswap] authorize retry ${i + 1}/${maxRetries}...`);
                await sleep(3000);
            }

            const authRes = await this.http.post(`${BASE}/api/face-video/authorize`, {
                anonymousDeviceId: deviceId,
                requestId: crypto.randomUUID(),
            }, {
                headers: {
                    'x-workbench-kind': 'face-video',
                    'x-workbench-trace-id': newTraceId(),
                    'x-anonymous-device-id': deviceId,
                },
            });

            console.log('[faceswap] authorize status:', authRes.status);
            console.log('[faceswap] authorize body:', JSON.stringify(authRes.data).slice(0, 300));

            const ticket = deepFind(authRes.data, ['ticket']);
            const remaining = deepFind(authRes.data, ['remaining']);

            if (ticket) {
                console.log('[faceswap] ✅ got ticket, remaining:', remaining);
                return ticket;
            }

            // Kalau status code 403 atau AUTH_FAILED → device bermasalah
            if (authRes.status === 403 || authRes.data?.statusCode === 403) {
                throw new Error(
                    `Authorize 403 (device rejected). ` +
                    `Coba pakai FJ_DEVICE dari browser. Response: ${JSON.stringify(authRes.data).slice(0, 200)}`
                );
            }
        }

        throw new Error('Authorize failed — no ticket after retries. Coba set env FJ_DEVICE dari browser.');
    }

    // ── 3. Upload sign ──
    async getUploadSign(files) {
        const res = await this.http.post(`${BASE}/api/face-video/upload-sign`, {
            functionTag: 'videofaceswap',
            files,
        }, {
            headers: {
                'x-workbench-kind': 'face-video',
                'x-workbench-trace-id': newTraceId(),
            },
        });

        const uploads = deepFind(res.data, ['uploads']) || [];
        if (uploads.length < files.length) {
            throw new Error(`Only got ${uploads.length} upload URLs (need ${files.length})`);
        }
        return uploads;
    }

    // ── 4. Upload ke S3 ──
    async uploadFile(presignedUrl, buffer, contentType) {
        const res = await axios.put(presignedUrl, buffer, {
            headers: {
                'Content-Type': contentType,
                'Content-Length': buffer.length,
            },
            timeout: 120000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            validateStatus: () => true,
        });

        if (res.status !== 200 && res.status !== 204) {
            throw new Error(`S3 upload HTTP ${res.status}`);
        }
        return true;
    }

    // ── 5. UUID ──
    async getUuid(ticket, deviceId) {
        const res = await this.http.post(`${BASE}/api/face-video/uuid`,
            { functionTag: 'videofaceswap' },
            {
                headers: {
                    'x-workbench-kind': 'face-video',
                    'x-workbench-trace-id': newTraceId(),
                    'x-anonymous-ticket': ticket,
                    'x-anonymous-device-id': deviceId,
                },
            }
        );

        const uId = typeof res.data === 'string' ? res.data : deepFind(res.data, ['uId']);
        if (!uId) throw new Error('No uId');
        return uId;
    }

    // ── 6. Sign ──
    async sign(videoUrl, faceUrl, uId, deviceId, ticket) {
        const res = await this.http.post(`${BASE}/api/face-video/sign`, {
            modelfile: videoUrl,
            imagefile: [faceUrl],
            imagefile2: [],
            priority: '1',
            uId,
            aiFunAction: 'videofaceswap',
            platFormId: '',
            check: '0',
            pointId: deviceId,
            consumeType: 'Customizeswapvideo',
            requestType: '1',
        }, {
            headers: {
                'x-workbench-kind': 'face-video',
                'x-workbench-trace-id': newTraceId(),
                'x-anonymous-ticket': ticket,
                'x-anonymous-device-id': deviceId,
            },
        });

        if (res.status !== 200) {
            throw new Error(`sign HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
        }

        const decrypt = deepFind(res.data, ['decrypt']);
        const signHash = deepFind(res.data, ['sign']);
        if (!decrypt || !signHash) throw new Error('No decrypt/sign in response');
        return { decrypt, sign: signHash };
    }

    // ── 7. Submit (attempt A — sudah confirmed works) ──
    async submit(decrypt, signHash, uId, deviceId, ticket) {
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

        const res = await this.http.post(`${BASE}/api/face-video/submit`, fd, {
            headers: {
                ...fd.getHeaders(),
                'x-workbench-kind': 'face-video',
                'x-workbench-trace-id': newTraceId(),
                'x-anonymous-ticket': ticket,
                'x-anonymous-device-id': deviceId,
                'Accept': '*/*',
            },
        });

        console.log('[faceswap] submit status:', res.status);
        console.log('[faceswap] submit body:', JSON.stringify(res.data).slice(0, 300));

        const obtainKey = deepFind(res.data, ['obtainKey']);
        if (!obtainKey) {
            throw new Error(`Submit failed: ${JSON.stringify(res.data).slice(0, 200)}`);
        }
        return obtainKey;
    }

    // ── 8. Polling result ──
    async pollResult(obtainKey, deviceId, ticket, { maxAttempts = 8, intervalMs = 5000 } = {}) {
        for (let i = 0; i < maxAttempts; i++) {
            await sleep(intervalMs);

            const res = await this.http.post(`${BASE}/api/face-video/result`,
                { obtainKey },
                {
                    headers: {
                        'x-workbench-kind': 'face-video',
                        'x-workbench-trace-id': newTraceId(),
                        'x-anonymous-ticket': ticket,
                        'x-anonymous-device-id': deviceId,
                    },
                }
            );

            const url = deepFind(res.data, ['url', 'videoUrl', 'resultUrl', 'outputUrl']);
            const state = deepFind(res.data, ['state', 'status']);

            console.log(`[faceswap] poll ${i + 1}: state=${state} url=${url ? 'yes' : 'no'}`);

            if (url) {
                return { url, state: state || 'done', obtainKey };
            }
            if (state === 'failed' || state === 'error') {
                throw new Error(`Task failed: ${JSON.stringify(res.data).slice(0, 200)}`);
            }
        }

        return { url: null, state: 'processing', obtainKey };
    }

    // ── Main flow ──
    async run(videoBuffer, faceBuffer) {
        // 0. Warm-up
        await this.http.get(`${BASE}/video-face-swap/`);

        // 1. Device ID
        const deviceId = await this.getDeviceId();

        // 2. Upload sign
        const videoFilename = crypto.randomBytes(50).toString('base64url') + '.mp4';
        const faceFilename = 'face_' + Date.now() + '.jpg';

        const uploads = await this.getUploadSign([
            { filename: videoFilename, contentType: 'video/mp4', size: videoBuffer.length },
            { filename: faceFilename, contentType: 'image/jpeg', size: faceBuffer.length },
        ]);

        const videoUp = uploads[0];
        const faceUp = uploads[1];

        // 3. Upload ke S3
        await this.uploadFile(videoUp.uploadUrl, videoBuffer, 'video/mp4');
        await this.uploadFile(faceUp.uploadUrl, faceBuffer, 'image/jpeg');

        // 4. Authorize
        const ticket = await this.authorize(deviceId);

        // 5. UUID
        const uId = await this.getUuid(ticket, deviceId);

        // 6. Sign
        const { decrypt, sign: signHash } = await this.sign(
            videoUp.cdnUrl,
            faceUp.cdnUrl,
            uId,
            deviceId,
            ticket
        );

        // 7. Submit
        const obtainKey = await this.submit(decrypt, signHash, uId, deviceId, ticket);

        // 8. Poll
        const result = await this.pollResult(obtainKey, deviceId, ticket);

        return {
            ...result,
            uId,
            deviceId: deviceId.slice(0, 40) + '...',
            uploadedUrls: {
                video: videoUp.cdnUrl,
                face: faceUp.cdnUrl,
            },
        };
    }

    // ── Check status by obtainKey ──
    async checkStatus(obtainKey) {
        const deviceId = await this.getDeviceId();
        const ticket = await this.authorize(deviceId);

        const res = await this.http.post(`${BASE}/api/face-video/result`,
            { obtainKey },
            {
                headers: {
                    'x-workbench-kind': 'face-video',
                    'x-workbench-trace-id': newTraceId(),
                    'x-anonymous-ticket': ticket,
                    'x-anonymous-device-id': deviceId,
                },
            }
        );
        return res.data;
    }
}


// ══════════════════════════════════════════════════════════════════════
// Handler
// ══════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') { cors(res); return res.status(204).end(); }

    // ── GET ──
    if (req.method === 'GET') {
        // Cek status
        if (req.query.id) {
            try {
                const result = await new FaceSwap().checkStatus(req.query.id);
                return ok(res, result);
            } catch (e) {
                return err(res, e.message, 500);
            }
        }

        // Health check
        return ok(res, {
            service: 'video-face-swap',
            status: 'ok',
            env: {
                hasFjDevice: !!process.env.FJ_DEVICE,
            },
            usage: {
                'POST json': '{"videoUrl": "...", "faceUrl": "..."}',
                'POST multipart': 'video + face files (max 4.5 MB total)',
                'GET': '/api/v2/faceswap-video?id=<obtainKey>',
            },
            limits: {
                maxFileSize: `${MAX_FILE / 1024 / 1024} MB`,
                vercelPayloadLimit: '4.5 MB (Hobby) / 100 MB (Pro)',
                note: 'Gunakan JSON + URL (upload ke catbox.moe dulu) kalau file > 4 MB',
            },
        });
    }

    if (req.method !== 'POST') return err(res, 'Method not allowed', 405);

    const t0 = Date.now();

    try {
        let videoBuffer, faceBuffer;
        const ct = req.headers['content-type'] || '';

        // ═══ Mode 1: Multipart ═══
        if (ct.includes('multipart/form-data')) {
            const { files } = await parseMultipart(req);
            const map = {};
            for (const k of Object.keys(files || {})) {
                const f = Array.isArray(files[k]) ? files[k][0] : files[k];
                map[k.toLowerCase()] = f;
            }

            const vF = map['video'] || map['modelfile'] || map['source'];
            const fF = map['face'] || map['image'] || map['target'];

            if (!vF || !fF) {
                return err(res, 'Wajib upload 2 file: "video" dan "face"', 400);
            }

            videoBuffer = require('fs').readFileSync(vF.filepath);
            faceBuffer = require('fs').readFileSync(fF.filepath);

            try { require('fs').unlinkSync(vF.filepath); } catch {}
            try { require('fs').unlinkSync(fF.filepath); } catch {}
        }
        // ═══ Mode 2: JSON dengan URL ═══
        else if (ct.includes('application/json')) {
            const body = await parseJson(req);
            const videoUrl = body.videoUrl || body.video || body.model;
            const faceUrl = body.faceUrl || body.face || body.image;

            if (!videoUrl || !faceUrl) {
                return err(res, 'Body harus punya "videoUrl" dan "faceUrl"', 400);
            }

            const [vr, fr] = await Promise.all([
                axios.get(videoUrl, {
                    responseType: 'arraybuffer',
                    timeout: 60000,
                    maxContentLength: MAX_FILE,
                    validateStatus: () => true,
                    headers: { 'User-Agent': UA },
                }),
                axios.get(faceUrl, {
                    responseType: 'arraybuffer',
                    timeout: 60000,
                    maxContentLength: MAX_FILE,
                    validateStatus: () => true,
                    headers: { 'User-Agent': UA },
                }),
            ]);

            if (vr.status !== 200) return err(res, `Fetch video HTTP ${vr.status}`, 502);
            if (fr.status !== 200) return err(res, `Fetch face HTTP ${fr.status}`, 502);

            videoBuffer = Buffer.from(vr.data);
            faceBuffer = Buffer.from(fr.data);
        } else {
            return err(res, 'Content-Type harus multipart/form-data atau application/json', 415);
        }

        if (videoBuffer.length > MAX_FILE || faceBuffer.length > MAX_FILE) {
            return err(res, `File terlalu besar (max ${MAX_FILE / 1024 / 1024} MB)`, 413);
        }

        // ── Run face swap ──
        const result = await new FaceSwap().run(videoBuffer, faceBuffer);

        return ok(res, {
            url: result.url,
            status: result.url ? 'done' : result.state,
            obtainKey: result.obtainKey,
            statusUrl: result.url ? null : `/api/v2/faceswap-video?id=${result.obtainKey}`,
            deviceUsed: result.deviceId,
            uploadedUrls: result.uploadedUrls,
            elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
        });

    } catch (e) {
        console.error('[faceswap] error:', e.message);
        return err(res, e.message, 500, {
            elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
            hint: e.message.includes('403')
                ? 'Set env FJ_DEVICE di Vercel (ambil cookie fj_device dari browser).'
                : undefined,
        });
    }
};
