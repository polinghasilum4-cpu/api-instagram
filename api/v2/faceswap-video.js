/**
 * Video Face Swap — Fully Auto (no env needed)
 * ============================================
 * Auto: device ID, ticket, upload, submit, poll.
 * Device di-cache di memory & auto-refresh kalau expired.
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

module.exports.config = { api: { bodyParser: false } };

// ══════════════════════════════════════════════════════════════════════
// Global cache — dipertahankan selama function masih warm
// ══════════════════════════════════════════════════════════════════════
let CACHE = {
    deviceId: null,
    ticket: null,
    expiresAt: 0,
};

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════
const cors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
};
const ok = (res, data) => { cors(res); return res.status(200).json({ success: true, data }); };
const err = (res, msg, status = 400, extra = {}) => { cors(res); return res.status(status).json({ success: false, error: msg, ...extra }); };
const trace = () => crypto.randomUUID();
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
        form.parse(req, (e, fields, files) => e ? reject(e) : resolve({ fields, files }));
    });
}

function parseJson(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', c => data += c);
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    });
}

// ══════════════════════════════════════════════════════════════════════
// Client — bikin session baru tiap kali, device di-cache global
// ══════════════════════════════════════════════════════════════════════
function newHttp() {
    const jar = new CookieJar();
    const http = wrapper(axios.create({
        jar,
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
    return { http, jar };
}

// ── Extract device + ticket (auto, cache, retry) ──
async function getSession() {
    // Kalau cache masih valid (< 5 menit), pakai
    if (CACHE.deviceId && CACHE.ticket && Date.now() < CACHE.expiresAt) {
        console.log('[session] using cache');
        return CACHE;
    }

    console.log('[session] refreshing...');
    const { http, jar } = newHttp();

    // Warm-up
    await http.get(`${BASE}/video-face-swap/`);

    // Retry sampai dapet device + ticket
    const maxTry = 5;
    for (let i = 0; i < maxTry; i++) {
        if (i > 0) {
            console.log(`[session] retry ${i + 1}/${maxTry}`);
            await sleep(2000);
        }

        // 1. Device session
        const sess = await http.get(`${BASE}/api/device/session`, {
            headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': trace() },
        });
        const deviceId = deepFind(sess.data, ['anonymousDeviceId', 'deviceId']);
        if (!deviceId) continue;
        console.log('[session] device:', deviceId.slice(0, 40));

        await jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);

        // 2. Authorize
        const auth = await http.post(`${BASE}/api/face-video/authorize`, {
            anonymousDeviceId: deviceId,
            requestId: crypto.randomUUID(),
        }, {
            headers: {
                'x-workbench-kind': 'face-video',
                'x-workbench-trace-id': trace(),
                'x-anonymous-device-id': deviceId,
            },
        });

        const ticket = deepFind(auth.data, ['ticket']);
        if (ticket) {
            console.log('[session] ✅ got ticket');
            CACHE = {
                deviceId,
                ticket,
                expiresAt: Date.now() + 5 * 60 * 1000, // 5 menit
            };
            return CACHE;
        }
        console.log('[session] no ticket, status:', auth.status, JSON.stringify(auth.data).slice(0, 100));
    }

    throw new Error('Gagal dapet ticket setelah 5x retry. Coba lagi nanti.');
}

// ── Upload file (pakai device dari cache) ──
async function uploadSign(files) {
    const { http, jar } = newHttp();
    const { deviceId } = await getSession();
    await jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);

    const res = await http.post(`${BASE}/api/face-video/upload-sign`, {
        functionTag: 'videofaceswap',
        files,
    }, {
        headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': trace() },
    });

    const uploads = deepFind(res.data, ['uploads']) || [];
    if (uploads.length < files.length) throw new Error('No upload URLs');
    return uploads;
}

// ── Full flow ──
async function processFaceSwap(videoBuffer, faceBuffer) {
    const { http, jar } = newHttp();
    const { deviceId, ticket } = await getSession();
    await jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);

    // 1. Upload sign
    const videoFn = crypto.randomBytes(50).toString('base64url') + '.mp4';
    const faceFn = 'face_' + Date.now() + '.jpg';

    const uploads = await uploadSign([
        { filename: videoFn, contentType: 'video/mp4', size: videoBuffer.length },
        { filename: faceFn, contentType: 'image/jpeg', size: faceBuffer.length },
    ]);

    const videoUp = uploads[0];
    const faceUp = uploads[1];

    // 2. Upload ke S3
    await axios.put(videoUp.uploadUrl, videoBuffer, {
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': videoBuffer.length },
        maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000, validateStatus: () => true,
    });
    await axios.put(faceUp.uploadUrl, faceBuffer, {
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': faceBuffer.length },
        maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000, validateStatus: () => true,
    });

    // 3. UUID
    const uuidRes = await http.post(`${BASE}/api/face-video/uuid`,
        { functionTag: 'videofaceswap' },
        {
            headers: {
                'x-workbench-kind': 'face-video',
                'x-workbench-trace-id': trace(),
                'x-anonymous-ticket': ticket,
                'x-anonymous-device-id': deviceId,
            },
        }
    );
    const uId = typeof uuidRes.data === 'string' ? uuidRes.data : deepFind(uuidRes.data, ['uId']);
    if (!uId) throw new Error('No uId');

    // 4. Sign
    const signRes = await http.post(`${BASE}/api/face-video/sign`, {
        modelfile: videoUp.cdnUrl,
        imagefile: [faceUp.cdnUrl],
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
            'x-workbench-trace-id': trace(),
            'x-anonymous-ticket': ticket,
            'x-anonymous-device-id': deviceId,
        },
    });
    const decrypt = deepFind(signRes.data, ['decrypt']);
    const sign = deepFind(signRes.data, ['sign']);
    if (!decrypt || !sign) {
        // Ticket mungkin expired, invalidate cache
        CACHE = { deviceId: null, ticket: null, expiresAt: 0 };
        throw new Error('Sign gagal — cache di-reset, coba lagi');
    }

    // 5. Submit
    const fd = new FormData();
    fd.append('decrypt', decrypt);
    fd.append('pkgName', 'com.enjoy.facejoy.web');
    fd.append('sign', sign);
    fd.append('content', JSON.stringify({ enhancerEnable: false }));
    fd.append('uId', uId);
    fd.append('version', '3');
    fd.append('anonymousDeviceId', deviceId);
    fd.append('uuId', deviceId);
    fd.append('pointId', deviceId);

    const submitRes = await http.post(`${BASE}/api/face-video/submit`, fd, {
        headers: {
            ...fd.getHeaders(),
            'x-workbench-kind': 'face-video',
            'x-workbench-trace-id': trace(),
            'x-anonymous-ticket': ticket,
            'x-anonymous-device-id': deviceId,
            'Accept': '*/*',
        },
    });
    const obtainKey = deepFind(submitRes.data, ['obtainKey']);
    if (!obtainKey) throw new Error('Submit failed: ' + JSON.stringify(submitRes.data).slice(0, 200));

    // 6. Poll (max 8 x 5s = 40s, di bawah limit Vercel Pro 60s)
    for (let i = 0; i < 8; i++) {
        await sleep(5000);
        const r = await http.post(`${BASE}/api/face-video/result`,
            { obtainKey },
            {
                headers: {
                    'x-workbench-kind': 'face-video',
                    'x-workbench-trace-id': trace(),
                    'x-anonymous-ticket': ticket,
                    'x-anonymous-device-id': deviceId,
                },
            }
        );
        const url = deepFind(r.data, ['url', 'videoUrl', 'resultUrl']);
        const state = deepFind(r.data, ['state', 'status']);
        if (url) return { url, state, obtainKey };
        if (state === 'failed' || state === 'error') throw new Error('Task failed');
    }

    return { url: null, state: 'processing', obtainKey };
}

// ══════════════════════════════════════════════════════════════════════
// Handler
// ══════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') { cors(res); return res.status(204).end(); }

    if (req.method === 'GET') {
        return ok(res, {
            service: 'video-face-swap',
            status: 'ok',
            mode: 'fully-auto',
            cache: CACHE.deviceId ? 'warm' : 'cold',
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
            const vF = map['video'] || map['source'];
            const fF = map['face'] || map['image'];
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
                axios.get(vUrl, { responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true, headers: { 'User-Agent': UA } }),
                axios.get(fUrl, { responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true, headers: { 'User-Agent': UA } }),
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

        const result = await processFaceSwap(videoBuffer, faceBuffer);

        return ok(res, {
            url: result.url,
            status: result.url ? 'done' : result.state,
            obtainKey: result.obtainKey,
            elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
        });

    } catch (e) {
        console.error('[faceswap]', e.message);
        return err(res, e.message, 500, {
            elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
        });
    }
};
