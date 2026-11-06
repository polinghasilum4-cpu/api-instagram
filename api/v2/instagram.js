// api/v2/instagram.js
// Parse: downloadgram (+ savefromins fallback)
// Download: selalu lewat API ini (?ig=&i=) biar tetap di domain user, tidak redirect ke web luar

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';

const ALLOWED_ORIGINS = [
  'https://xs0cietylabsz.biz.id',
  'https://www.xs0cietylabsz.biz.id',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Requested-With');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type, Content-Length');
}

function json(res, data, status = 200) {
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
  if (!/(^|\.)instagram\.com$/i.test(u.hostname) && !/(^|\.)instagr\.am$/i.test(u.hostname)) {
    throw new Error('URL harus dari instagram.com');
  }
  let path = u.pathname;
  if (!path.endsWith('/')) path += '/';
  return `https://www.instagram.com${path}`;
}

function inferType(url, extra) {
  const s = String(extra || url || '').toLowerCase();
  if (/\.mp4|\.mov/.test(s)) return 'video';
  if (/\.jpe?g|\.png|\.webp|_n\.jpg/.test(s) && !/\.mp4/.test(s)) return 'image';
  if (/video/.test(s)) return 'video';
  if (/image|thumb|jpg|png/.test(s)) return 'image';
  return 'video';
}

function decodeJsString(s) {
  return String(s)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractDownloadgram(raw) {
  const html = decodeJsString(raw);
  const streams = [];
  const seen = new Set();

  const cdnRe = /https:\/\/cdn\.downloadgram\.org\/\?token=([A-Za-z0-9._\-]+)/g;
  let m;
  while ((m = cdnRe.exec(html)) !== null) {
    const url = m[0];
    const token = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    let payload = '';
    try {
      payload = Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8');
    } catch (_) {}
    streams.push({ url, type: inferType(url, payload), thumbnail: null });
  }

  if (!streams.length) {
    const mediaRe = /https:\/\/(?:scontent|instagram)[^"'\\\s<>]+/g;
    while ((m = mediaRe.exec(html)) !== null) {
      let url = m[0].replace(/&amp;/g, '&');
      if (seen.has(url)) continue;
      if (!/(cdninstagram|fbcdn|\.mp4|\.jpg|\.jpeg|\.png)/i.test(url)) continue;
      seen.add(url);
      streams.push({ url, type: inferType(url), thumbnail: null });
    }
  }

  const thumb = html.match(/<img[^>]+src=["'](https:\/\/[^"']+)["']/i);
  if (thumb) {
    const t = thumb[1].replace(/&amp;/g, '&');
    for (const s of streams) if (!s.thumbnail) s.thumbnail = t;
  }

  streams.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
  return streams;
}

async function parseDownloadgram(link) {
  const variants = [...new Set([link, link.replace(/\/$/, ''), link.replace('://www.', '://')])];
  let lastErr = null;
  for (const tryUrl of variants) {
    try {
      const res = await fetch('https://api.downloadgram.org/media', {
        method: 'POST',
        headers: {
          'user-agent': UA,
          'content-type': 'application/x-www-form-urlencoded',
          accept: '*/*',
          origin: 'https://downloadgram.org',
          referer: 'https://downloadgram.org/',
        },
        body: new URLSearchParams({ url: tryUrl }),
        signal: AbortSignal.timeout(28000),
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = JSON.parse(text); msg = j.message || j.error || msg; } catch (_) {}
        lastErr = new Error(msg);
        if (res.status >= 500) break;
        continue;
      }
      const streams = extractDownloadgram(text);
      if (!streams.length) {
        lastErr = new Error('Media tidak ditemukan');
        continue;
      }
      return { streams, source: 'downloadgram' };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr || new Error('downloadgram gagal');
}

const SF_BASE = 'https://savefromins.com';
const SF_API = 'https://api.savefromins.com/api/contentsite_api/media/parse';
let cachedToken = null;
let cachedAt = 0;

async function scrapeToken() {
  try {
    const htmlRes = await fetch(SF_BASE + '/', {
      headers: { 'user-agent': UA, accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
    });
    if (!htmlRes.ok) return null;
    const html = await htmlRes.text();
    const jsUrls = [];
    const re = /<script[^>]+src="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      let u = m[1];
      if (!u.startsWith('http')) u = SF_BASE + (u.startsWith('/') ? '' : '/') + u;
      jsUrls.push(u);
    }
    const patterns = [
      /auth["']?\s*[:=]\s*["'](2025\d{4}[a-z0-9]{6,})["']/i,
      /["'](2025\d{4}[a-z0-9]{6,})["']/i,
    ];
    for (const u of jsUrls) {
      try {
        const js = await (await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(5000) })).text();
        for (const p of patterns) {
          const match = js.match(p);
          if (match && match[1]) return match[1];
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

async function getToken(force) {
  if (!force && cachedToken && Date.now() - cachedAt < 10 * 60 * 1000) return cachedToken;
  const fresh = await scrapeToken();
  cachedToken = fresh || cachedToken || '20250901majwlqo';
  cachedAt = Date.now();
  return cachedToken;
}

async function parseSavefromins(link) {
  for (const force of [false, true]) {
    const token = await getToken(force);
    const res = await fetch(SF_API, {
      method: 'POST',
      headers: {
        'user-agent': UA,
        'content-type': 'application/x-www-form-urlencoded',
        origin: SF_BASE,
        referer: SF_BASE + '/',
      },
      body: new URLSearchParams({
        auth: token,
        domain: 'api-ak.savefromins.com',
        origin: 'source',
        link,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    if (j.data) {
      const out = [];
      const seen = new Set();
      const info = j.data.data || j.data;
      for (const r of info.resources || []) {
        if (!r.download_url || seen.has(r.download_url)) continue;
        seen.add(r.download_url);
        out.push({
          url: r.download_url,
          type: inferType(r.download_url),
          thumbnail: r.thumbnail || info.thumbnail || null,
        });
      }
      if (out.length) {
        out.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
        return { streams: out, source: 'savefromins' };
      }
    }
    if (!force) await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('savefromins gagal');
}

async function resolveMedia(link) {
  const errors = [];
  try { return await parseDownloadgram(link); } catch (e) { errors.push(String(e.message || e)); }
  try { return await parseSavefromins(link); } catch (e) { errors.push(String(e.message || e)); }
  throw new Error(errors.join(' | '));
}

// ---- stream download lewat API (tetap di domain user) ----
async function handleDownload(req, res, q) {
  const ig = q.ig;
  const idx = Number(q.i || 0);
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
      'user-agent': UA,
      accept: '*/*',
      referer: target.includes('downloadgram') ? 'https://downloadgram.org/' : 'https://www.instagram.com/',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(55000),
  });

  if (!upstream.ok) {
    res.statusCode = 502;
    res.end('upstream ' + upstream.status);
    return;
  }

  const shortcode = (link.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) || [null, 'media'])[1];
  const ct = upstream.headers.get('content-type')
    || (streams[idx].type === 'image' ? 'image/jpeg' : 'video/mp4');
  const ext = (ct.includes('image') || streams[idx].type === 'image') ? 'jpg' : 'mp4';

  res.setHeader('Content-Type', ct);
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  res.setHeader('Content-Disposition', `attachment; filename="ig_${shortcode}_${idx}.${ext}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;

  const reader = upstream.body.getReader();
  req.on('close', () => { try { reader.cancel(); } catch (_) {} });

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

module.exports = async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const q = req.query || {};

    // Mode download file — tetap di api-instagram-five.vercel.app
    if (q.ig) {
      await handleDownload(req, res, q);
      return;
    }

    // Mode parse
    let link = null;
    if (req.method === 'GET') {
      link = q.url;
    } else if (req.method === 'POST') {
      const body = typeof req.body === 'string'
        ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
        : (req.body || {});
      link = body.url || q.url;
    } else {
      return json(res, { ok: false, error: 'method not allowed' }, 405);
    }

    if (!link) {
      return json(res, {
        ok: true,
        service: 'instagram-downloader',
        status: 'ok',
        usage: { GET: '/api/v2/instagram?url=...', download: '?ig=...&i=0' },
      });
    }

    const clean = normalizeIgUrl(link);
    const { streams, source } = await resolveMedia(clean);

    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const self = `${proto}://${host}/api/v2/instagram`;
    const ig64 = b64urlEnc(clean);

    // download = URL API sendiri (bukan CDN luar)
    return json(res, {
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
        download: `${self}?ig=${encodeURIComponent(ig64)}&i=${i}`,
      })),
    });
  } catch (e) {
    console.error('[instagram]', e);
    if (!res.headersSent) {
      setCors(req, res);
      json(res, { ok: false, error: String((e && e.message) || e) }, 422);
    }
  }
};
