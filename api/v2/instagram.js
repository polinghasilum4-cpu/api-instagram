// api/v2/instagram.js
// Parse: savevid.net (Primary) -> Native Embed (Fallback) -> Savefromins (Fallback)
// Download: selalu lewat API ini (?ig=&i=) biar tetap di domain user

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

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

// ── 1. SAVEVID.NET PARSER (Primary - Berdasarkan cURL dari lu) ──
async function parseSavevid(link) {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    timeout: 30000,
    validateStatus: () => true
  }));

  try {
    // 1. Warm up buat dapet cookie fpestid
    await client.get('https://savevid.net/id');

    // 2. Hit userverify buat dapet cftoken
    const verifyRes = await client.post('https://savevid.net/api/userverify', 
      new URLSearchParams({ url: link }).toString(), 
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
          'Origin': 'https://savevid.net',
          'Referer': 'https://savevid.net/id'
        }
      }
    );

    let cftoken = '';
    let verifyData = verifyRes.data;
    if (typeof verifyData === 'string') {
      try { verifyData = JSON.parse(verifyData); } catch (_) {}
    }

    if (verifyData && verifyData.cftoken) {
      cftoken = verifyData.cftoken;
    } else if (typeof verifyRes.data === 'string') {
      const match = verifyRes.data.match(/cftoken["']?:\s*["']([^"']+)/);
      if (match) cftoken = match[1];
    }

    if (!cftoken) throw new Error('Gagal mendapatkan cftoken dari savevid.net');

    // 3. Hit ajaxSearch buat dapet link media
    const searchBody = new URLSearchParams({
      q: link,
      t: 'media',
      lang: 'id',
      v: 'v2',
      cftoken: cftoken
    }).toString();

    const searchRes = await client.post('https://v3.savevid.net/api/ajaxSearch', searchBody, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        'Origin': 'https://savevid.net',
        'Referer': 'https://savevid.net/'
      }
    });

    const html = searchRes.data.data || searchRes.data;
    if (typeof html !== 'string') throw new Error('Response savevid.net tidak valid');

    // 4. Extract Links (menggunakan regex untuk cari href atau url media)
    const streams = [];
    const seen = new Set();

    // Regex untuk nangkep link download (biasanya dari snapcdn atau fbcdn)
    const urlRegex = /(https:\/\/[^"'\s\\]+)/g;
    let m;
    while ((m = urlRegex.exec(html)) !== null) {
      let url = m[1].replace(/&amp;/g, '&');
      
      // Filter URL yang gak relevan
      if (url.includes('savevid.net') && !url.includes('/api/download')) continue;
      if (url.includes('google') || url.includes('facebook.com/')) continue;
      if (!/(snapcdn|fbcdn|cdninstagram|\.mp4|\.jpg|\.jpeg|\.png|\.webp)/i.test(url)) continue;
      
      if (seen.has(url)) continue;
      seen.add(url);
      
      streams.push({ 
        url, 
        type: inferType(url, html), 
        thumbnail: null 
      });
    }

    if (!streams.length) throw new Error('Media tidak ditemukan di halaman savevid.net');

    // Urutkan video paling atas
    streams.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
    
    // Cari thumbnail (opsional)
    const thumbMatch = html.match(/<img[^>]+src="([^"]+)"/i);
    if (thumbMatch) {
      const t = thumbMatch[1];
      for (const s of streams) s.thumbnail = t;
    }

    return { streams, source: 'savevid' };

  } catch (e) {
    throw new Error('savevid.net error: ' + e.message);
  }
}

// ── 2. NATIVE PARSER (Fallback 1) ──
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

// ── 3. SAVEFROMINS PARSER (Fallback 2) ──
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

// ── RESOLVER UTAMA (Savevid -> Native -> Savefromins) ──
async function resolveMedia(link) {
  const errors = [];
  
  // 1. Savevid.net (Paling ngebut & jarang down)
  try { 
    console.log('[IG] Mencoba Savevid.net...');
    return await parseSavevid(link); 
  } catch (e) { 
    errors.push(`Savevid: ${e.message}`); 
  }

  // 2. Native Embed
  try { 
    console.log('[IG] Mencoba Native Parser...');
    return await parseNative(link); 
  } catch (e) { 
    errors.push(`Native: ${e.message}`); 
  }

  // 3. Savefromins
  try { 
    console.log('[IG] Mencoba Savefromins...');
    return await parseSavefromins(link); 
  } catch (e) { 
    errors.push(`Savefromins: ${e.message}`); 
  }

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
      referer: target.includes('savevid') ? 'https://savevid.net/' : 'https://www.instagram.com/',
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

    // Dual format: ok/media (baru) + status/data.resources (frontend lama)
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