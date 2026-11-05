// javascript | api/v2/instagram.js | Node.js | Vercel
// Instagram downloader — token auto-scrape dari savefromins.com
// Routes:
//   GET/POST /api/v2/instagram?url=...   parse mode
//   GET /api/v2/instagram?ig=<b64url>&i=N  download mode (stream)
// Auto-heal: stream expired (401/403/410/412) → re-scrape token → retry

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';
const BASE = 'https://savefromins.com';
const API_URL = 'https://api.savefromins.com/api/contentsite_api/media/parse';

const ALLOWED_ORIGINS = [
  process.env.ALLOWED_ORIGIN || 'https://xs0cietylabsz.biz.id',
  'https://xs0cietylabsz.biz.id',
  'https://www.xs0cietylabsz.biz.id',
].filter((v, i, a) => a.indexOf(v) === i);

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Requested-With');
  res.setHeader('Vary', 'Origin');
}

function jsonOut(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

// ---- token cache ---------------------------------------------------------

let cachedToken = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000;
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
          if (match && match[1]) return match[1];
        }
      } catch (_) {}
    }
  } catch (_) {}
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

function b64urlEnc(s) {
  return Buffer.from(String(s), 'utf8').toString('base64url');
}
function b64urlDec(s) {
  return Buffer.from(String(s), 'base64url').toString('utf8');
}

function normalizeIgUrl(input) {
  const u = new URL(input);
  if (
    !/(^|\.)instagram\.com$/i.test(u.hostname) &&
    !/(^|\.)instagr\.am$/i.test(u.hostname)
  ) {
    throw new Error('Only instagram.com / instagr.am URLs are supported.');
  }
  u.hash = '';
  // strip tracking query noise but keep essential path
  return u.origin + u.pathname.replace(/\/+$/, '/') + (u.pathname.endsWith('/') ? '' : '');
}

// more careful normalize — keep path, drop junk query
function normalizeIgUrlSafe(input) {
  const u = new URL(String(input).trim());
  if (
    !/(^|\.)instagram\.com$/i.test(u.hostname) &&
    !/(^|\.)instagr\.am$/i.test(u.hostname)
  ) {
    throw new Error('Only instagram.com / instagr.am URLs are supported.');
  }
  // keep only path, drop query/hash (psln etc not needed)
  let path = u.pathname;
  if (!path.endsWith('/')) path += '/';
  return `https://www.instagram.com${path}`;
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
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) throw new Error(`upstream parse http ${res.status}`);
  const j = await res.json();
  if (!j.data) throw new Error(`upstream no data: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data;
}

// ---- extract streams -----------------------------------------------------

function inferType(s) {
  if (!s) return 'video';
  const t = String(s).toLowerCase();
  if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/.test(t) || /image/.test(t)) return 'image';
  return 'video';
}

function pickStr(n, keys) {
  if (!n || typeof n !== 'object') return null;
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

  const info = root && (root.data || root);
  let resources = (info && info.resources) || [];

  if ((!resources || resources.length === 0) && info && Array.isArray(info.media)) {
    resources = [];
    for (const m of info.media) {
      if (Array.isArray(m.resources)) resources.push(...m.resources);
    }
  }

  for (const r of resources || []) {
    const url = r && r.download_url;
    if (!url || !String(url).startsWith('http') || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      type: inferType(url),
      thumbnail: pickStr(r, ['thumbnail', 'thumb', 'cover', 'poster']) || (info && info.thumbnail) || null,
      t: 0,
    });
  }

  if (out.length === 0) {
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        n.forEach(walk);
        return;
      }
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

  out.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
  return out;
}

async function resolveStreams(link, forceRefresh = false) {
  const token = await getToken(forceRefresh);
  const data = await parseUpstream(link, token);
  const streams = extractStreams(data);
  return { streams, data };
}

// ---- download stream -----------------------------------------------------

const STREAM_HEADERS = {
  'user-agent': UA,
  'sec-ch-ua-platform': '"Android"',
  'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
  'sec-ch-ua-mobile': '?1',
  accept: 'video/mp4,video/*;q=0.9,image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  referer: BASE + '/',
  'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
};

async function handleDownload(req, res, sp) {
  const ig = sp.ig;
  const idx = Number(sp.i || 0);
  if (!ig) {
    res.statusCode = 400;
    res.end('ig required');
    return;
  }
  if (!Number.isInteger(idx) || idx < 0) {
    res.statusCode = 400;
    res.end('i invalid');
    return;
  }

  const link = normalizeIgUrlSafe(b64urlDec(ig));
  let { streams } = await resolveStreams(link);

  if (idx >= streams.length) {
    res.statusCode = 404;
    res.end('index out of range');
    return;
  }

  let target = streams[idx].url;
  let upstream = await fetch(target, { headers: STREAM_HEADERS, redirect: 'follow' });

  if ([401, 403, 410, 412].includes(upstream.status)) {
    ({ streams } = await resolveStreams(link, true));
    if (idx >= streams.length) {
      res.statusCode = 404;
      res.end('index out of range after refresh');
      return;
    }
    target = streams[idx].url;
    upstream = await fetch(target, { headers: STREAM_HEADERS, redirect: 'follow' });
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    res.statusCode = 502;
    res.end(`upstream ${upstream.status}: ${body.slice(0, 200)}`);
    return;
  }

  const shortcode = (link.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) || [null, 'media'])[1];
  const ct = upstream.headers.get('content-type') || 'video/mp4';
  const ext = ct.includes('image') ? 'jpg' : 'mp4';

  res.setHeader('Content-Type', ct);
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  res.setHeader('Content-Disposition', `attachment; filename="ig_${shortcode}_${idx}.${ext}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;

  const reader = upstream.body.getReader();
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => res.once('drain', r));
        }
      }
      res.end();
    } catch (e) {
      try { res.end(); } catch (_) {}
    }
  };

  req.on('close', () => {
    try { reader.cancel(); } catch (_) {}
  });

  await pump();
}

// ---- parse ---------------------------------------------------------------

async function handleParse(req, res) {
  let link = null;

  if (req.method === 'GET') {
    link = req.query && req.query.url;
  } else if (req.method === 'POST') {
    const body = typeof req.body === 'string'
      ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
      : (req.body || {});
    link = body.url || (req.query && req.query.url);
  } else {
    return jsonOut(res, { ok: false, error: 'method not allowed' }, 405);
  }

  if (!link) {
    return jsonOut(res, {
      ok: true,
      service: 'instagram-downloader',
      status: 'ok',
      usage: {
        GET: '/api/v2/instagram?url=<instagram_url>',
        POST: '{"url":"https://instagram.com/..."}',
      },
    }, 200);
  }

  const clean = normalizeIgUrlSafe(link);

  let token = await getToken();
  let raw = await parseUpstream(clean, token);
  let streams = extractStreams(raw);

  if (!streams.length) {
    token = await getToken(true);
    await new Promise((r) => setTimeout(r, 800));
    raw = await parseUpstream(clean, token);
    streams = extractStreams(raw);
  }

  if (!streams.length) {
    return jsonOut(res, {
      ok: false,
      error: 'no media found',
      preview: JSON.stringify(raw).slice(0, 400),
    }, 422);
  }

  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const self = `${proto}://${host}/api/v2/instagram`;
  const ig64 = b64urlEnc(clean);
  const now = Math.floor(Date.now() / 1000);
  const info = (raw && raw.data) || raw;

  return jsonOut(res, {
    ok: true,
    source: 'savefromins',
    instagram_url: clean,
    title: typeof (info && info.title) === 'string' ? info.title.trim().slice(0, 120) : null,
    thumbnail: (info && info.thumbnail) || (streams[0] && streams[0].thumbnail) || null,
    username: (info && info.user_item && info.user_item.nickname) || null,
    count: streams.length,
    media: streams.map((s, i) => ({
      index: i,
      type: s.type,
      thumbnail: s.thumbnail || null,
      expires_at: s.t || null,
      expires_in: s.t ? Math.max(0, s.t - now) : null,
      download: `${self}?ig=${encodeURIComponent(ig64)}&i=${i}`,
    })),
  }, 200);
}

// ---- entry ---------------------------------------------------------------

module.exports = async (req, res) => {
  try {
    setCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const q = req.query || {};
    if (q.ig) {
      await handleDownload(req, res, q);
      return;
    }

    await handleParse(req, res);
  } catch (e) {
    console.error('[instagram]', e);
    if (!res.headersSent) {
      setCors(req, res);
      jsonOut(res, { ok: false, error: String((e && e.message) || e) }, 502);
    }
  }
};
