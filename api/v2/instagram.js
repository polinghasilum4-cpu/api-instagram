// api/v2/instagram.js
// Parse: Cobalt -> JerryCoder -> Reelflow -> Native -> Savefromins
// Download: selalu lewat API ini (?ig=&i=) biar tetap di domain user

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { instagram: jerryCoderInstagram } = require('@jerrycoder/instagram-api');
const reelflow = require('reelflow');

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36';

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
  if (/\.mp4|\.mov|video/.test(s)) return 'video';
  if (/\.jpe?g|\.png|\.webp|_n\.jpg|image/.test(s)) return 'image';
  return 'video';
}

// ── 1. COBALT API (Primary) ──
async function parseCobalt(link) {
  const res = await axios.post('https://api.cobalt.tools/api/json', {
    url: link
  }, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA
    },
    timeout: 20000,
    validateStatus: () => true
  });

  const data = res.data;
  if (!data) throw new Error('Response Cobalt kosong');

  if (data.status === 'error') {
    throw new Error(data.text || 'Cobalt error');
  }

  if (data.status === 'redirect' || data.status === 'success' || data.status === 'stream') {
    const streams = [{
      url: data.url,
      type: inferType(data.url),
      thumbnail: null
    }];
    streams.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
    return { streams, source: 'cobalt' };
  }

  if (data.status === 'picker' && Array.isArray(data.picker)) {
    const streams = data.picker.map(item => ({
      url: item.url,
      type: inferType(item.url),
      thumbnail: item.thumb || null
    }));
    streams.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
    return { streams, source: 'cobalt' };
  }

  throw new Error('Struktur response Cobalt tidak dikenali');
}

// ── 2. JERRYCODER API (Fallback 1) ──
async function parseJerryCoder(link) {
  const data = await jerryCoderInstagram(link);
  if (!data || data.status !== 'success' || !data.data) {
    throw new Error('JerryCoder gagal atau response tidak valid');
  }

  const mediaData = data.data;
  const url = mediaData.url || mediaData.videoUrl;
  if (!url) throw new Error('Tidak ada URL media dari JerryCoder');

  const streams = [{
    url: url,
    type: inferType(url),
    thumbnail: mediaData.thumbnail || null
  }];
  streams.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
  return { streams, source: 'jerrycoder' };
}

// ── 3. REELFLOW (Fallback 2) ──
async function parseReelflow(link) {
  const videoInfo = await reelflow.getVideoInfo(link);
  if (!videoInfo || !videoInfo.videoUrl) {
    throw new Error('Reelflow tidak menemukan video');
  }
  const streams = [{
    url: videoInfo.videoUrl,
    type: 'video',
    thumbnail: null
  }];
  return { streams, source: 'reelflow' };
}

// ── 4. NATIVE PARSER (Fallback 3) ──
async function parseNative(link) {
  const shortcodeMatch = link.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!shortcodeMatch) throw new Error('Shortcode tidak ditemukan di URL');
  const shortcode = shortcodeMatch[1];

  const endpoints = [
    `https://www.instagram.com/reel/${shortcode}/embed/`,
    `https://www.instagram.com/p/${shortcode}/embed/`
  ];

  let lastErr = null;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) { lastErr = new Error(`Embed HTTP ${res.status}`); continue; }

      const html = await res.text();
      const streams = [];
      const seen = new Set();
      let thumbnail = null;

      const thumbMatch = html.match(/"display_url":"([^"]+)"/) || html.match(/<meta property="og:image" content="([^"]+)"/);
      if (thumbMatch) thumbnail = thumbMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');

      const videoMatches = html.match(/"video_url":"([^"]+)"/g);
      if (videoMatches) {
        for (const v of videoMatches) {
          let videoUrl = v.match(/"video_url":"([^"]+)"/)[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
          if (!seen.has(videoUrl)) { seen.add(videoUrl); streams.push({ url: videoUrl, type: 'video', thumbnail: null }); }
        }
      }

      const imgMatches = html.match(/"display_url":"([^"]+)"/g);
      if (imgMatches) {
        for (const i of imgMatches) {
          let imgUrl = i.match(/"display_url":"([^"]+)"/)[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
          if (!seen.has(imgUrl)) { seen.add(imgUrl); streams.push({ url: imgUrl, type: 'image', thumbnail: null }); }
        }
      }

      if (thumbnail) for (const s of streams) { if (!s.thumbnail) s.thumbnail = thumbnail; }

      if (streams.length > 0) {
        streams.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
        return { streams, source: 'native_embed' };
      }
      lastErr = new Error('Media tidak ditemukan di halaman embed');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Native parse gagal');
}

// ── 5. SAVEFROMINS PARSER (Fallback 4) ──
const SF_BASE = 'https://savefromins.com';
const SF_API = 'https://api.savefromins.com/api/contentsite_api/media/parse';
let cachedToken = null;
let cachedAt = 0;

async function scrapeToken() {
  try {
    const htmlRes = await fetch(SF_BASE + '/', { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(8000) });
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
    const patterns = [ /auth["']?\s*[:=]\s*["'](202\d{5}[a-z0-9]{6,})["']/i, /["'](202\d{5}[a-z0-9]{6,})["']/i ];
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
      headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', origin: SF_BASE, referer: SF_BASE + '/' },
      body: new URLSearchParams({ auth: token, domain: 'api-ak.savefromins.com', origin: 'source', link }),
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
        out.push({ url: r.download_url, type: inferType(r.download_url), thumbnail: r.thumbnail || info.thumbnail || null });
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

// ── RESOLVER UTAMA ──
async function resolveMedia(link) {
  const errors = [];

  // 1. Cobalt API
  try {
    console.log('[IG] Mencoba Cobalt...');
    return await parseCobalt(link);
  } catch (e) { errors.push(`Cobalt: ${e.message}`); }

  // 2. JerryCoder
  try {
    console.log('[IG] Mencoba JerryCoder...');
    return await parseJerryCoder(link);
  } catch (e) { errors.push(`JerryCoder: ${e.message}`); }

  // 3. Reelflow
  try {
    console.log('[IG] Mencoba Reelflow...');
    return await parseReelflow(link);
  } catch (e) { errors.push(`Reelflow: ${e.message}`); }

  // 4. Native Embed
  try {
    console.log('[IG] Mencoba Native Parser...');
    return await parseNative(link);
  } catch (e) { errors.push(`Native: ${e.message}`); }

  // 5. Savefromins
  try {
    console.log('[IG] Mencoba Savefromins...');
    return await parseSavefromins(link);
  } catch (e) { errors.push(`Savefromins: ${e.message}`); }

  throw new Error(errors.join(' | '));
}

// ---- stream download lewat API (tetap di domain user) ----
async function handleDownload(req, res, q) {
  const ig = q.ig;
  const idx = Number(q.i || 0);
  if (!ig) { res.statusCode = 400; res.end('ig required'); return; }
  if (!Number.isInteger(idx) || idx < 0) { res.statusCode = 400; res.end('i invalid'); return; }

  const link = normalizeIgUrl(b64urlDec(ig));
  const { streams } = await resolveMedia(link);
  if (idx >= streams.length) { res.statusCode = 404; res.end('index out of range'); return; }

  const target = streams[idx].url;
  const upstream = await fetch(target, {
    headers: {
      'user-agent': UA,
      accept: '*/*',
      referer: 'https://www.instagram.com/',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(55000),
  });

  if (!upstream.ok) { res.statusCode = 502; res.end('upstream ' + upstream.status); return; }

  const shortcode = (link.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) || [null, 'media'])[1];
  const ct = upstream.headers.get('content-type') || (streams[idx].type === 'image' ? 'image/jpeg' : 'video/mp4');
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
  } catch (_) { try { res.end(); } catch (_) {} }
}

module.exports = async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    const q = req.query || {};

    // Mode download file
    if (q.ig) { await handleDownload(req, res, q); return; }

    // Mode parse
    let link = null;
    if (req.method === 'GET') {
      link = q.url;
    } else if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
      link = body.url || q.url;
    } else {
      return json(res, { ok: false, error: 'method not allowed' }, 405);
    }

    if (!link) {
      return json(res, { ok: true, service: 'instagram-downloader', status: 'ok', usage: { GET: '/api/v2/instagram?url=...', download: '?ig=...&i=0' } });
    }

    const clean = normalizeIgUrl(link);
    const { streams, source } = await resolveMedia(clean);

    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const self = `${proto}://${host}/api/v2/instagram`;
    const ig64 = b64urlEnc(clean);

    const media = streams.map((s, i) => ({
      index: i,
      type: s.type,
      thumbnail: s.thumbnail || null,
      download: `${self}?ig=${encodeURIComponent(ig64)}&i=${i}`,
    }));
    const resources = streams.map((s, i) => ({
      download_url: `${self}?ig=${encodeURIComponent(ig64)}&i=${i}`,
      format: s.type === 'image' ? 'jpg' : 'mp4',
    }));

    return json(res, {
      ok: true,
      status: true,
      source,
      instagram_url: clean,
      title: null,
      thumbnail: (streams[0] && streams[0].thumbnail) || null,
      username: null,
      count: streams.length,
      media,
      data: {
        title: 'Instagram Media',
        like_count: 0,
        comment_count: 0,
        thumbnail: (streams[0] && streams[0].thumbnail) || null,
        resources,
      },
    });
  } catch (e) {
    console.error('[instagram]', e);
    if (!res.headersSent) {
      setCors(req, res);
      json(res, { ok: false, error: String((e && e.message) || e) }, 422);
    }
  }
};
