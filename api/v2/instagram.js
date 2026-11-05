// javascript | api/v2/instagram.js | Node.js 20 | Vercel Hobby
// Instagram downloader via savefromins.com — single file, auto-scrape credentials.
// Routes:
//   POST /api/v2/instagram             body {"url":"https://instagram.com/..."}
//   GET  /api/v2/instagram?url=...     parse mode
//   GET  /api/v2/instagram?ig=<b64>&i=N download mode (streaming)
// Env opsional: ALLOWED_ORIGIN

import crypto from 'node:crypto';

export const config = { maxDuration: 300 };

const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';
const BASE = 'https://savefromins.com';
const API_URL = 'https://api.savefromins.com/api/contentsite_api/media/parse';

const ALLOWED = process.env.ALLOWED_ORIGIN || '*';
const CORS = {
  'Access-Control-Allow-Origin': ALLOWED,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// --- credential cache -----------------------------------------------------

const CRED_TTL_MS = 30 * 60_000; // 30 menit
const HARDCODED = {
  auth: 'f8a1c2d4',
  key:  Buffer.from('f8a1c2d4f8a1c2d4f8a1c2d4f8a1c2d4', 'utf8'),
};
let cachedCred = null;
let cachedCredAt = 0;

async function fetchText(url, ms = 8000) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(ms),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.text();
}

async function scrapeCredentials() {
  const home = await fetchText(BASE + '/');

  const srcs = [...home.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/g)]
    .map(m => m[1])
    .map(u => (u.startsWith('http') ? u : BASE + (u.startsWith('/') ? '' : '/') + u));

  for (const src of srcs) {
    let js;
    try { js = await fetchText(src, 8000); }
    catch { continue; }

    // 1. Locate the crypto chunk: it defines `E="..."` and calls AES.decrypt,
    //    referencing c=r(NNN) where c.gJ is used to derive the AES key.
    const eMatch = js.match(/let\s+E\s*=\s*["']([^"']+)["']\s*,\s*S\s*=\s*\[\s*c\.gJ/);
    if (!eMatch) continue;

    const auth = eMatch[1]; // AUTH token (E) — sama dengan yang dipakai di POST body

    // 2. Find c = r(NNN)
    const cBind = js.match(/(?<![.\w$])c\s*=\s*(?:r|n)\((\d+)\)/);
    if (!cBind) continue;
    const modNum = cBind[1];

    // 3. Fetch the module chunk that contains module NNN and extract gJ/QU
    let gJ = null, QU = null;
    for (const otherSrc of srcs) {
      let other;
      try { other = await fetchText(otherSrc, 8000); }
      catch { continue; }

      const modPat = new RegExp(`\\b${modNum}\\s*:\\s*function`);
      if (!modPat.test(other)) continue;

      const gJm = other.match(/let\s+\w+\s*=\s*\{[^{}]*?\}/g);
      // Direct approach: search for `gJ:function(){return X}` then X="..."
      const gJref = other.match(/gJ\s*:\s*function\s*\(\s*\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)/);
      const QUref = other.match(/QU\s*:\s*function\s*\(\s*\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)/);

      if (gJref) {
        const nm = gJref[1];
        const val = other.match(new RegExp(`(?:let|const|var)\\s+${nm}\\s*=\\s*["']([^"']+)["']`));
        if (val) gJ = val[1];
      }
      if (QUref) {
        const nm = QUref[1];
        const val = other.match(new RegExp(`(?:let|const|var)\\s+${nm}\\s*=\\s*["']([^"']+)["']`));
        if (val) QU = val[1];
      }
      if (gJ) break;
    }

    if (!gJ) continue;

    // 4. Recompute AES-256 key = gJ + E + E + E (32 bytes)
    const keyStr = gJ + auth + auth + auth;
    if (keyStr.length !== 32) continue;

    return { auth, key: Buffer.from(keyStr, 'utf8'), source: 'scrape' };
  }
  return null;
}

async function getCredentials(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedCred && now - cachedCredAt < CRED_TTL_MS) {
    return cachedCred;
  }
  try {
    const fresh = await scrapeCredentials();
    if (fresh) {
      cachedCred = fresh;
      cachedCredAt = now;
      return fresh;
    }
  } catch { /* fallback */ }
  cachedCred = HARDCODED;
  cachedCredAt = now;
  return cachedCred;
}

// --- utils ----------------------------------------------------------------

const jsonOut = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
  });

const b64urlEnc = s => Buffer.from(s, 'utf8').toString('base64url');
const b64urlDec = s => Buffer.from(s, 'base64url').toString('utf8');

function decrypt(b64, key) {
  const ct = Buffer.from(b64, 'base64');
  const iv = key.subarray(0, 16);
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  d.setAutoPadding(false);
  let pt = Buffer.concat([d.update(ct), d.final()]);
  let end = pt.length;
  while (end > 0 && pt[end - 1] === 0) end--;
  return pt.subarray(0, end).toString('utf8');
}

function normalizeIgUrl(input) {
  const u = new URL(input);
  if (
    !/(^|\.)instagram\.com$/i.test(u.hostname) &&
    !/(^|\.)instagr\.am$/i.test(u.hostname)
  ) throw new Error('Only instagram.com / instagr.am URLs are supported.');
  u.hash = '';
  return u.toString();
}

// --- upstream -------------------------------------------------------------

async function parseUpstream(link, cred) {
  const body = new URLSearchParams({
    auth: cred.auth,
    domain: 'api-ak.savefromins.com',
    origin: 'source',
    link,
  });
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      'sec-ch-ua-platform': '"Android"',
      'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
      'sec-ch-ua-mobile': '?1',
      accept: '*/*',
      origin: BASE,
      referer: BASE + '/',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const err = new Error(`upstream http ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  if (!j.data) throw new Error(`no data: ${JSON.stringify(j).slice(0, 200)}`);

  const plain = decrypt(j.data, cred.key);
  try {
    return JSON.parse(plain);
  } catch {
    throw new Error(`decrypt ok but not JSON: ${plain.slice(0, 200)}`);
  }
}

async function parseWithAutoHeal(link) {
  // Attempt 1: cached credentials
  let cred = await getCredentials();
  try {
    return await parseUpstream(link, cred);
  } catch (e1) {
    const isAuthErr = [401, 403, 410, 412].includes(e1.status);
    const isDecryptErr = /decrypt|not JSON|no data/i.test(e1.message || '');
    if (!isAuthErr && !isDecryptErr) throw e1;

    // Attempt 2: force re-scrape credentials (token atau key berubah)
    cred = await getCredentials(true);
    return await parseUpstream(link, cred);
  }
}

// --- extract --------------------------------------------------------------

function inferType(s) {
  if (!s) return 'video';
  const t = String(s).toLowerCase();
  if (/\.(jpg|jpeg|png|webp|gif)/.test(t) || /image/.test(t)) return 'image';
  return 'video';
}

function pickStr(n, keys) {
  for (const k of keys) {
    const v = n[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim();
  }
  return null;
}

function buildProxyUrl(n) {
  const p = new URLSearchParams();
  p.set('request', String(n.request));
  p.set('sign', String(n.sign));
  if (n.t != null) p.set('t', String(n.t));
  return `https://api-ak.savefromins.com/api/gateway/proxy/stream?${p}`;
}

function extractStreams(root) {
  const out = [];
  const seen = new Set();
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.request && n.sign) {
      const url = buildProxyUrl(n);
      if (!seen.has(url)) {
        seen.add(url);
        out.push({
          url,
          type: n.type || n.media_type || inferType(n.request),
          thumbnail: pickStr(n, ['thumbnail', 'thumb', 'cover', 'poster']),
          t: Number(n.t) || 0,
        });
      }
    } else {
      const direct = pickStr(n, [
        'download_url', 'downloadUrl',
        'video_url', 'videoUrl',
        'url', 'src', 'play',
      ]);
      if (direct && /^https?:\/\//i.test(direct) && !seen.has(direct)) {
        if (/(cdninstagram|fbcdn|savefromins|\.mp4|\.jpg|\.jpeg|\.png|\.webp)/i.test(direct)) {
          seen.add(direct);
          out.push({
            url: direct,
            type: n.type || n.media_type || inferType(direct),
            thumbnail: pickStr(n, ['thumbnail', 'thumb', 'cover', 'poster']),
            t: Number(n.t) || 0,
          });
        }
      }
    }
    for (const v of Object.values(n)) {
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(root);
  return out;
}

// --- download -------------------------------------------------------------

const STREAM_HEADERS = {
  'user-agent': UA,
  'sec-ch-ua-platform': '"Android"',
  'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
  'sec-ch-ua-mobile': '?1',
  accept:
    'video/mp4,video/*;q=0.9,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  referer: BASE + '/',
  'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
};

async function resolveStreams(link) {
  const data = await parseWithAutoHeal(link);
  return extractStreams(data);
}

async function handleDownload(sp) {
  try {
    const ig = sp.get('ig');
    const idx = Number(sp.get('i') || 0);
    if (!ig) return new Response('ig required', { status: 400, headers: CORS });
    if (!Number.isInteger(idx) || idx < 0) {
      return new Response('i invalid', { status: 400, headers: CORS });
    }

    const link = normalizeIgUrl(b64urlDec(ig));
    let streams = await resolveStreams(link);
    if (idx >= streams.length) {
      return new Response('index out of range', { status: 404, headers: CORS });
    }

    let upstream = await fetch(streams[idx].url, { headers: STREAM_HEADERS, redirect: 'follow' });

    if ([401, 403, 410, 412].includes(upstream.status)) {
      streams = await resolveStreams(link);
      if (idx >= streams.length) {
        return new Response('index out of range after refresh', { status: 404, headers: CORS });
      }
      upstream = await fetch(streams[idx].url, { headers: STREAM_HEADERS, redirect: 'follow' });
    }

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      return new Response(`upstream ${upstream.status}: ${body.slice(0, 200)}`, {
        status: 502, headers: CORS,
      });
    }

    const shortcode =
      (link.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) || [null, 'media'])[1];
    const ct = upstream.headers.get('content-type') || 'video/mp4';
    const ext = ct.includes('image') ? 'jpg' : 'mp4';

    const h = new Headers(CORS);
    h.set('content-type', ct);
    const len = upstream.headers.get('content-length');
    if (len) h.set('content-length', len);
    h.set('content-disposition', `attachment; filename="ig_${shortcode}_${idx}.${ext}"`);
    h.set('cache-control', 'no-store');

    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (e) { controller.error(e); }
      },
      cancel(r) { upstream.body.cancel(r).catch(() => {}); },
    });

    return new Response(stream, { status: 200, headers: h });
  } catch (e) {
    return new Response(`download error: ${e?.message || e}`, { status: 502, headers: CORS });
  }
}

// --- parse ----------------------------------------------------------------

async function handleParse(req, u) {
  try {
    let link;
    if (req.method === 'GET') {
      link = u.searchParams.get('url');
    } else if (req.method === 'POST') {
      const ct = req.headers.get('content-type') || '';
      if (ct.includes('application/json')) link = (await req.json()).url;
      else link = (await req.formData()).get('url');
    } else {
      return jsonOut({ ok: false, error: 'method not allowed' }, 405);
    }
    if (!link) return jsonOut({ ok: false, error: 'url required' }, 400);

    const clean = normalizeIgUrl(link);
    const data = await parseWithAutoHeal(clean);
    const streams = extractStreams(data);

    if (!streams.length) {
      return jsonOut(
        { ok: false, error: 'no media found', preview: JSON.stringify(data).slice(0, 400) },
        422
      );
    }

    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    const self = `${proto}://${host}${u.pathname}`;
    const ig64 = b64urlEnc(clean);
    const now = Math.floor(Date.now() / 1000);

    return jsonOut({
      ok: true,
      source: 'savefromins',
      instagram_url: clean,
      title: typeof data.title === 'string' ? data.title.trim().slice(0, 120) : null,
      thumbnail: data.thumbnail || streams[0]?.thumbnail || null,
      count: streams.length,
      media: streams.map((s, i) => ({
        index: i,
        type: s.type,
        thumbnail: s.thumbnail || null,
        expires_at: s.t || null,
        expires_in: s.t ? Math.max(0, now ? 0 : 0, s.t - now) : null,
        download: `${self}?ig=${encodeURIComponent(ig64)}&i=${i}`,
      })),
    });
  } catch (e) {
    return jsonOut({ ok: false, error: String(e?.message || e) }, 502);
  }
}

// --- entry ----------------------------------------------------------------

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const u = new URL(req.url);
  if (u.searchParams.has('ig')) return handleDownload(u.searchParams);
  return handleParse(req, u);
  }
