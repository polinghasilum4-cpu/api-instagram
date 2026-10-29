/**
 * _lib/security.js — Shared hardening middleware
 * ================================================
 * Env vars (set di Vercel Project Settings → Environment Variables):
 *   API_KEYS          = "key1,key2"   → kalau kosong, endpoint TETAP TERBUKA (no-op, backward compatible).
 *                        Isi ini supaya cuma client yang punya key (bot WA/Telegram/web lo) yang bisa panggil API.
 *   ALLOWED_ORIGINS   = "https://situs-lo.com,https://app-lo.com" → kalau kosong, CORS fallback ke '*'
 *                        (browser lain masih bisa fetch, tapi ini TIDAK menghalangi bot/curl/Node —
 *                        CORS cuma ditegakkan oleh browser, bukan oleh server lain. API_KEYS yang
 *                        beneran nahan scraper/bot).
 *
 * PENTING: CORS lock & API key adalah 2 lapisan BEDA.
 *   - ALLOWED_ORIGINS → cegah situs lain nge-embed/fetch API lo dari browser korban.
 *   - API_KEYS        → cegah siapapun (bot, curl, script scraper) manggil API tanpa izin.
 * Untuk tujuan "API gua ga bisa diambil scraper / bot Tele / WA gua", yang paling ngaruh itu API_KEYS.
 */

const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');

// ---------------------------------------------------------------------
// Config dari env
// ---------------------------------------------------------------------
const API_KEYS = (process.env.API_KEYS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------
// IP extraction (trust proxy: Cloudflare / Vercel)
// ---------------------------------------------------------------------
function getClientIp(req) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    const xrip = req.headers['x-real-ip'];
    if (xrip) return xrip.trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------
function applyCors(req, res, { methods = 'GET, POST, OPTIONS' } = {}) {
    const origin = req.headers.origin;

    if (ALLOWED_ORIGINS.length > 0) {
        if (origin && ALLOWED_ORIGINS.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        }
        // origin lain / tanpa origin (server-to-server) → header ini gak di-set,
        // browser lain akan ke-block CORS-nya sendiri.
    } else {
        // belum dikonfigurasi -> fallback permisif, biar gak ngerusak integrasi existing
        res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-Filename, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

// ---------------------------------------------------------------------
// API key (timing-safe compare)
// ---------------------------------------------------------------------
function timingSafeStringEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        // tetap jalanin compare dummy biar durasi konsisten (anti timing attack)
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function requireApiKey(req, res) {
    if (API_KEYS.length === 0) return true; // belum di-set di env -> endpoint tetap terbuka

    const key = req.headers['x-api-key'] || (req.query && req.query.apikey);
    if (!key) {
        res.status(401).json({ success: false, error: 'Missing API key. Kirim header X-Api-Key.' });
        return false;
    }
    const valid = API_KEYS.some(k => timingSafeStringEqual(key, k));
    if (!valid) {
        res.status(401).json({ success: false, error: 'API key tidak valid.' });
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------
// Rate limiting (in-memory, per instance)
// CATATAN: Vercel serverless = tiap cold start/region punya memory sendiri,
// jadi ini "best effort", bukan rate limit global yang presisi. Untuk
// limit yang akurat lintas region, pakai Upstash Redis (@upstash/ratelimit).
// ---------------------------------------------------------------------
const buckets = new Map();

function rateLimit(req, res, { windowMs = 60000, max = 30 } = {}) {
    const ip = getClientIp(req);
    const now = Date.now();
    let b = buckets.get(ip);

    if (!b || now - b.start > windowMs) {
        b = { start: now, count: 0 };
        buckets.set(ip, b);
    }
    b.count++;

    if (buckets.size > 5000) { // simple cleanup biar gak bocor memory
        for (const [k, v] of buckets) {
            if (now - v.start > windowMs * 5) buckets.delete(k);
        }
    }

    if (b.count > max) {
        res.setHeader('Retry-After', Math.ceil((b.start + windowMs - now) / 1000));
        res.status(429).json({ success: false, error: 'Terlalu banyak request, coba lagi sebentar lagi.' });
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------
// SSRF guard — validasi URL + resolve DNS, tolak kalau mengarah ke IP privat
// (RFC1918, loopback, link-local 169.254.0.0/16 termasuk metadata 169.254.169.254)
// ---------------------------------------------------------------------
function isPrivateIp(ip) {
    if (net.isIPv6(ip)) {
        const low = ip.toLowerCase();
        return low === '::1' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('::ffff:127.');
    }
    return /^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.)/.test(ip);
}

async function assertPublicUrl(urlStr) {
    let u;
    try { u = new URL(urlStr); } catch { throw new Error('URL tidak valid'); }

    if (!['http:', 'https:'].includes(u.protocol)) {
        throw new Error(`Protocol ${u.protocol} tidak diizinkan`);
    }

    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
        throw new Error('Hostname tidak diizinkan');
    }

    if (net.isIP(host)) {
        if (isPrivateIp(host)) throw new Error('Private/internal IP tidak diizinkan');
        return u;
    }

    let addrs = [];
    try {
        addrs = await dns.resolve4(host);
    } catch {
        try { addrs = await dns.resolve6(host); } catch { /* biarin axios yg nentuin gagal/nggaknya */ }
    }
    for (const addr of addrs) {
        if (isPrivateIp(addr)) {
            throw new Error('Domain resolve ke private/internal IP (diblokir, anti-SSRF)');
        }
    }
    return u;
}

module.exports = {
    getClientIp,
    applyCors,
    requireApiKey,
    rateLimit,
    isPrivateIp,
    assertPublicUrl,
};
