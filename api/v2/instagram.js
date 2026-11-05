// javascript | api/v2/instagram.js | Node.js | Vercel
// Instagram downloader
// Primary  : downloadgram.org (no auth token)
// Fallback : savefromins.com (auto-scrape token + retry)
// Routes:
//   GET/POST /api/v2/instagram?url=...
//   GET /api/v2/instagram?ig=<b64url>&i=N  (stream download)

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';

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

function b64urlEnc(s) {
  return Buffer.from(String(s), 'utf8').toString('base64url');
}
function b64urlDec(s) {
  return Buffer.from(String(s), 'base64url').toString('utf8');
}

function normalizeIgUrl(input) {
  const u = new URL(String(input).trim());
  if (
    !/(^|\.)instagram\.com$/i.test(u.hostname) &&
    !/(^|\.)instagr\.am$/i.test(u.hostname)
  ) {
    throw new Error('Only instagram.com / instagr.am URLs are supported.');
  }
  let path = u.pathname;
  if (!path.endsWith('/')) path += '/';
  return `https://www.instagram.com${path}`;
}

function inferType(url) {
  const t = String(url || '').toLowerCase();
  if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/.test(t)) return 'image';
  if (/\/v\/t51\.|image|jpg|jpeg|png|webp/.test(t) && !/\.mp4|video|\.mov/.test(t)) return 'image';
  return 'video';
}

// ---- downloadgram.org ----------------------------------------------------

function decodeJsString(s) {
  // Handles \xNN and \uNNNN sequences from downloadgram JS payload
  return String(s)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function extractFromDownloadgramHtml(raw) {
  const html = decodeJsString(raw);
  const streams = [];
  const seen = new Set();

  // Prefer direct cdn.downloadgram.org token links (stable proxy)
  const cdnRe = /https:\/\/cdn\.downloadgram\.org\/\?token=([A-Za-z0-9._\-]+)/g;
  let m;
  while ((m = cdnRe.exec(html)) !== null) {
    const url = m[0];
    const token = m[1];
    if (seen.has(url)) continue;
    seen.add(url);

    // Decode JWT payload (middle part) to detect file type accurately
    let type = 'video';
    try {
      const payload = token.split('.')[1] || '';
      const json = Buffer.from(payload, 'base64url').toString('utf8');
      if (/\.jpe?g|\.png|\.webp|_n\.jpg/i.test(json) && !/\.mp4|\.mov/i.test(json)) {
        type = 'image';
      } else if (/\.mp4|\.mov|video/i.test(json)) {
        type = 'video';
      }
    } catch (_) {
      type = /\.mp4/i.test(url) ? 'video' : (/\.jpe?g|\.png/i.test(url) ? 'image' : 'video');
    }
    streams.push({ url, type, thumbnail: null, t: 0 });
  }

  // Fallback: raw cdninstagram / fbcdn links
  if (!streams.length) {
    const mediaRe = /https:\/\/(?:scontent|instagram)[^"'\\\s<>]+/g;
    while ((m = mediaRe.exec(html)) !== null) {
      let url = m[0].replace(/&amp;/g, '&');
      if (seen.has(url)) continue;
      if (!/(cdninstagram|fbcdn|\.mp4|\.jpg|\.jpeg|\.png)/i.test(url)) continue;
      seen.add(url);
      streams.push({ url, type: inferType(url), thumbnail: null, t: 0 });
    }
  }

  // Thumbnail from <img src=...>
  const thumbMatch = html.match(/<img[^>]+src=["'](https:\/\/[^"']+)["']/i);
  const thumb = thumbMatch ? thumbMatch[1].replace(/&amp;/g, '&') : null;
  if (thumb && streams.length) {
    for (const s of streams) {
      if (!s.thumbnail) s.thumbnail = thumb;
    }
  }

  // Prefer video first
  streams.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
  return streams;
}

async function parseDownloadgram(link) {
  const res = await fetch('https://api.downloadgram.org/media', {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      accept: '*/*',
      origin: 'https://downloadgram.org',
      referer: 'https://downloadgram.org/',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    body: new URLSearchParams({ url: link }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`downloadgram http ${res.status}`);
  const text = await res.text();
  if (!text || text.length < 50) throw new Error('downloadgram empty response');

  const streams = extractFromDownloadgramHtml(text);
  if (!streams.length) throw new Error('downloadgram: no media found');
  return { streams, source: 'downloadgram', rawPreview: text.slice(0, 200) };
}

// ---- savefromins fallback ------------------------------------------------

const SF_BASE = 'https://savefromins.com';
const SF_API = 'https://api.savefromins.com/api/contentsite_api/media/parse';
const FALLBACK_TOKEN = '20250901majwlqo';

let cachedToken = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000;

async function scrapeToken() {
  try {
    const htmlRes = await fetch(SF_BASE + '/', {
      headers: { 'user-agent': UA, accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
    });
    if (!htmlRes.ok) return null;
    const html = await htmlRes.text();

    const jsUrls = [];
    const regex = /<script[^>]+src="([^"]+)"/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      let u = m[1];
      if (!u.startsWith('http')) u = SF_BASE + (u.startsWith('/') ? '' : '/') + u;
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
  if (!forceRefresh && cachedToken && now - cachedAt < CACHE_TTL) return cachedToken;
  const fresh = await scrapeToken();
  cachedToken = fresh || cachedToken || FALLBACK_TOKEN;
  cachedAt = now;
  return cachedToken;
}

function extractStreamsSf(root) {
  const out = [];
  const seen = new Set();
  const info = root && (root.data || root);
  let resources = (info && info.resources) || [];

  if ((!resources || !resources.length) && info && Array.isArray(info.media)) {
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
      thumbnail: (r && (r.thumbnail || r.thumb)) || (info && info.thumbnail) || null,
      t: 0,
    });
  }

  if (!out.length) {
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      for (const k of ['download_url', 'downloadUrl', 'video_url', 'videoUrl', 'url', 'src', 'play']) {
        const v = n[k];
        if (typeof v === 'string' && /^https?:\/\//i.test(v) && !seen.has(v)) {
          if (/(cdninstagram|fbcdn|savefromins|\.mp4|\.jpg|\.jpeg|\.png|\.webp)/i.test(v)) {
            seen.add(v);
            out.push({ url: v, type: inferType(v), thumbnail: null, t: 0 });
          }
        }
      }
      for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
    };
    walk(root);
  }

  out.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
  return out;
}

async function parseSavefromins(link) {
  let token = await getToken();
  const body = new URLSearchParams({
    auth: token,
    domain: 'api-ak.savefromins.com',
    origin: 'source',
    link,
  });

  let res = await fetch(SF_API, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      accept: '*/*',
      origin: SF_BASE,
      referer: SF_BASE + '/',
      'accept-language': 'id-ID,id;q=0.9,en;q=0.8',
    },
    body,
    signal: AbortSignal.timeout(20000),
  });

  let j = await res.json().catch(() => ({}));

  // Token expired / auth failed → force refresh once
  if (!res.ok || !j.data || j.status_code === 'auth_failed' || j.status_code === 'analyze_failed') {
    token = await getToken(true);
    const body2 = new URLSearchParams({
      auth: token,
      domain: 'api-ak.savefromins.com',
      origin: 'source',
      link,
    });
    res = await fetch(SF_API, {
      method: 'POST',
      headers: {
        'user-agent': UA,
        'content-type': 'application/x-www-form-urlencoded',
        accept: '*/*',
        origin: SF_BASE,
        referer: SF_BASE + '/',
      },
      body: body2,
      signal: AbortSignal.timeout(20000),
    });
    j = await res.json().catch(() => ({}));
  }

  if (!j.data) {
    throw new Error(`savefromins no data: ${JSON.stringify(j).slice(0, 200)}`);
  }

  const streams = extractStreamsSf(j.data);
  if (!streams.length) throw new Error('savefromins: no media found');
  return { streams, source: 'savefromins', rawPreview: null };
}

// ---- resolve with fallback -----------------------------------------------

async function resolveMedia(link) {
  const errors = [];

  try {
    return await parseDownloadgram(link);
  } catch (e) {
    errors.push(`downloadgram: ${e.message || e}`);
  }

  try {
    return await parseSavefromins(link);
  } catch (e) {
    errors.push(`savefromins: ${e.message || e}`);
  }

  throw new Error(errors.join(' | '));
}

// ---- download stream -----------------------------------------------------

const STREAM_HEADERS = {
  'user-agent': UA,
  accept: 'video/mp4,video/*;q=0.9,image/avif,image/webp,image/*,*/*;q=0.8',
  'accept-language': 'id-ID,id;q=0.9,en;q=0.8',
  referer: 'https://www.instagram.com/',
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

  const link = normalizeIgUrl(b64urlDec(ig));
  const { streams } = await resolveMedia(link);

  if (idx >= streams.length) {
    res.statusCode = 404;
    res.end('index out of range');
    return;
  }

  const target = streams[idx].url;
  const upstream = await fetch(target, {
    headers: {
      ...STREAM_HEADERS,
      // downloadgram CDN expects its own referer sometimes
      referer: target.includes('downloadgram') ? 'https://downloadgram.org/' : STREAM_HEADERS.referer,
    },
    redirect: 'follow',
  });

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    res.statusCode = 502;
    res.end(`upstream ${upstream.status}: ${body.slice(0, 200)}`);
    return;
  }

  const shortcode = (link.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) || [null, 'media'])[1];
  const ct = upstream.headers.get('content-type') || (streams[idx].type === 'image' ? 'image/jpeg' : 'video/mp4');
  const ext = ct.includes('image') || streams[idx].type === 'image' ? 'jpg' : 'mp4';

  res.setHeader('Content-Type', ct);
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  res.setHeader('Content-Disposition', `attachment; filename="ig_${shortcode}_${idx}.${ext}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;

  const reader = upstream.body.getReader();
  req.on('close', () => {
    try { reader.cancel(); } catch (_) {}
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once('drain', r));
      }
    }
    res.end();
  } catch (_) {
    try { res.end(); } catch (_) {}
  }
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
      upstreams: ['downloadgram', 'savefromins'],
      usage: {
        GET: '/api/v2/instagram?url=<instagram_url>',
        POST: '{"url":"https://instagram.com/..."}',
      },
    }, 200);
  }

  const clean = normalizeIgUrl(link);
  const { streams, source } = await resolveMedia(clean);

  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const self = `${proto}://${host}/api/v2/instagram`;
  const ig64 = b64urlEnc(clean);
  const now = Math.floor(Date.now() / 1000);

  return jsonOut(res, {
    ok: true,
    source,
    instagram_url: clean,
    title: null,
    thumbnail: (streams[0] && streams[0].thumbnail) || null,
    username: null,
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
