// javascript | api/v2/instagram.js | Node.js 20 | Vercel Hobby
// Instagram downloader — token auto-scrape dari savefromins.com
// Routes:
//   POST /api/v2/instagram               body {"url":"https://instagram.com/..."}
//   GET  /api/v2/instagram?url=...       parse mode
//   GET  /api/v2/instagram?ig=<b64url>&i=N download mode (streaming)
// Auto-heal: stream expired (401/403/410/412) → re-scrape token → stream ulang.

export const config = { maxDuration: 300 };

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';
const BASE = 'https://savefromins.com';
const API_URL = 'https://api.savefromins.com/api/contentsite_api/media/parse';

const ALLOWED_ORIGINS = [
  process.env.ALLOWED_ORIGIN || 'https://xs0cietylabsz.biz.id',
  'https://xs0cietylabsz.biz.id',
  'https://www.xs0cietylabsz.biz.id',
].filter((v, i, a) => a.indexOf(v) === i);

function corsHeaders(req) {
  const origin = req?.headers?.get?.('origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Filename, X-Requested-With',
    'Vary': 'Origin',
  };
}

// default static CORS (download path / when req unavailable)
const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Filename, X-Requested-With',
  'Vary': 'Origin',
};

// ---- token cache ---------------------------------------------------------

let cachedToken = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 menit
const FALLBACK_TOKEN = '20250901majwlqo';

async function scrapeToken() {
  try {
    const htmlRes = await fetch(BASE + '/', {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    const html = await htmlRes.text();

    const jsUrls = [];
    const regex = /<script[^>]+src="([^"]+)"/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      let u = m[1];
      if (!u.startsWith('http')) u = BASE + (u.startsWith('/') ? '' : '/') + u;
      jsUrls.push(u);
    }

    const patterns = [
      /auth["']?\s*[:=]\s*["'](2025\d{4}[a-z0-9]{6,})["']/i,
      /["'](2025\d{4}[a-z0-9]{6,})["']/i,
      /(2025\d{4}[a-z0-9]{6,})/i,
    ];

    for (const u of jsUrls) {
      try {
        const jsRes = await fetch(u, {
          headers: { 'user-agent': UA },
          signal: AbortSignal.timeout(5000),
        });
        const js = await jsRes.text();
        for (const p of patterns) {
          const match = js.match(p);
          if (match?.[1]) return match[1];
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function getToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && (now - cachedAt) < CACHE_TTL) return cachedToken;
  const fresh = await scrapeToken();
  cachedToken = fresh || cachedToken || FALLBACK_TOKEN;
  cachedAt = now;
  return cachedToken;
}

// ---- utils ---------------------------------------------------------------

const jsonOut = (data, status = 200, req = null) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...(req ? corsHeaders(req) : CORS), 'content-type': 'application/json; charset=utf-8' },
  });

const b64urlEnc = (s) => Buffer.from(s, 'utf8').toString('base64url');
const b64urlDec = (s) => Buffer.from(s, 'base64url').toString('utf8');

function normalizeIgUrl(input) {
  const u = new URL(input);
  if (
    !/(^|\.)instagram\.com$/i.test(u.hostname) &&
    !/(^|\.)instagr\.am$/i.test(u.hostname)
  ) throw new Error('Only instagram.com / instagr.am URLs are supported.');
  u.hash = '';
  return u.toString();
}

// ---- upstream ------------------------------------------------------------

async function parseUpstream(link, token) {
  const body = new URLSearchParams({
    auth: token,
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
      'x-forwarded-for': '103.47.132.1',
      'x-real-ip': '103.47.132.1',
    },
    body,
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`upstream parse http ${res.status}`);
  const j = await res.json();
  if (!j.data) throw new Error(`upstream no data: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data; // raw parsed data (no decrypt needed di v2)
}

// ---- extract streams -----------------------------------------------------

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

function extractStreams(root) {
  const out = [];
  const seen = new Set();

  // Coba ambil dari resources langsung
  const info = root?.data || root;
  let resources = info?.resources || [];

  if (resources.length === 0 && Array.isArray(info?.media)) {
    for (const m of info.media) {
      if (Array.isArray(m.resources)) resources.push(...m.resources);
    }
  }

  for (const r of resources) {
    const url = r.download_url;
    if (!url || !url.startsWith('http') || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      type: inferType(url),
      thumbnail: pickStr(r, ['thumbnail', 'thumb', 'cover', 'poster']) || info?.thumbnail || null,
      t: 0,
    });
  }

  // Fallback: walk seluruh object cari URL media
  if (out.length === 0) {
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const direct = pickStr(n, ['download_url', 'downloadUrl', 'video_url', 'videoUrl', 'url', 'src', 'play']);
      if (direct && /^https?:\/\//i.test(direct) && !seen.has(direct)) {
        if (/(cdninstagram|fbcdn|savefromins|\.mp4|\.jpg|\.jpeg|\.png|\.webp)/i.test(direct)) {
          seen.add(direct);
          out.push({ url: direct, type: inferType(direct), thumbnail: null, t: 0 });
        }
      }
      for (const v of Object.values(n)) {
        if (v && typeof v === 'object') walk(v);
      }
    };
    walk(root);
  }

  // Video duluan
  out.sort((a, b) => (b.type === 'video' ? 1 : -1));
  return out;
}

// ---- resolve streams -----------------------------------------------------

async function resolveStreams(link, forceRefresh = false) {
  const token = await getToken(forceRefresh);
  const data = await parseUpstream(link, token);
  const streams = extractStreams(data);
  return { streams, data };
}

// ---- download ------------------------------------------------------------

const STREAM_HEADERS = {
  'user-agent': UA,
  'sec-ch-ua-platform': '"Android"',
  'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
  'sec-ch-ua-mobile': '?1',
  accept: 'video/mp4,video/*;q=0.9,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  referer: BASE + '/',
  'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
};

async function handleDownload(sp, req = null) {
  const H = req ? corsHeaders(req) : CORS;
  try {
    const ig = sp.get('ig');
    const idx = Number(sp.get('i') || 0);
    if (!ig) return new Response('ig required', { status: 400, headers: H });
    if (!Number.isInteger(idx) || idx < 0) return new Response('i invalid', { status: 400, headers: H });

    const link = normalizeIgUrl(b64urlDec(ig));
    let { streams } = await resolveStreams(link);

    if (idx >= streams.length) return new Response('index out of range', { status: 404, headers: H });

    let target = streams[idx].url;
    let upstream = await fetch(target, { headers: STREAM_HEADERS, redirect: 'follow' });

    // Auto-heal: token expired → re-scrape → retry
    if ([401, 403, 410, 412].includes(upstream.status)) {
      ({ streams } = await resolveStreams(link, true));
      if (idx >= streams.length) return new Response('index out of range after refresh', { status: 404, headers: H });
      target = streams[idx].url;
      upstream = await fetch(target, { headers: STREAM_HEADERS, redirect: 'follow' });
    }

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      return new Response(`upstream ${upstream.status}: ${body.slice(0, 200)}`, { status: 502, headers: H });
    }

    const shortcode = (link.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) || [null, 'media'])[1];
    const ct = upstream.headers.get('content-type') || 'video/mp4';
    const ext = ct.includes('image') ? 'jpg' : 'mp4';

    const h = new Headers(H);
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
    return new Response(`download error: ${e?.message || e}`, { status: 502, headers: H });
  }
}

// ---- parse ---------------------------------------------------------------

async function handleParse(req, u) {
  const out = (data, status = 200) => jsonOut(data, status, req);
  try {
    let link;
    if (req.method === 'GET') {
      link = u.searchParams.get('url');
    } else if (req.method === 'POST') {
      const ct = req.headers.get('content-type') || '';
      if (ct.includes('application/json')) link = (await req.json()).url;
      else link = (await req.formData()).get('url');
    } else {
      return out({ ok: false, error: 'method not allowed' }, 405);
    }

    if (!link) return out({ ok: false, error: 'url required' }, 400);

    const clean = normalizeIgUrl(link);

    // Attempt 1
    let token = await getToken();
    let raw = await parseUpstream(clean, token);
    let streams = extractStreams(raw);

    // Attempt 2 — refresh token jika gagal
    if (!streams.length) {
      token = await getToken(true);
      await new Promise(r => setTimeout(r, 800));
      raw = await parseUpstream(clean, token);
      streams = extractStreams(raw);
    }

    if (!streams.length) {
      return out({ ok: false, error: 'no media found', preview: JSON.stringify(raw).slice(0, 400) }, 422);
    }

    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    const self = `${proto}://${host}${u.pathname}`;
    const ig64 = b64urlEnc(clean);
    const now = Math.floor(Date.now() / 1000);

    const info = raw?.data || raw;

    return out({
      ok: true,
      source: 'savefromins',
      instagram_url: clean,
      title: typeof info?.title === 'string' ? info.title.trim().slice(0, 120) : null,
      thumbnail: info?.thumbnail || streams[0]?.thumbnail || null,
      username: info?.user_item?.nickname || null,
      count: streams.length,
      media: streams.map((s, i) => ({
        index: i,
        type: s.type,
        thumbnail: s.thumbnail || null,
        expires_at: s.t || null,
        expires_in: s.t ? Math.max(0, s.t - now) : null,
        download: `${self}?ig=${encodeURIComponent(ig64)}&i=${i}`,
      })),
    });
  } catch (e) {
    return out({ ok: false, error: String(e?.message || e) }, 502);
  }
}

// ---- entry ---------------------------------------------------------------

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  const u = new URL(req.url);
  if (u.searchParams.has('ig')) return handleDownload(u.searchParams, req);
  return handleParse(req, u);
}
