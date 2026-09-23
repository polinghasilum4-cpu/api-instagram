/* ============================================================
 *  Instagram Downloader API — by xs0ciety
 *  
 *  Endpoint: GET /api/v2/instagram?url=<instagram_url>
 *  
 *  Fitur auto-generate token:
 *   1. Scrape token fresh dari bundle JS savefromins.com
 *   2. Cache token di memory (biar gak scrape tiap request)
 *   3. Kalau response gagal → auto re-scrape & retry sekali
 * ============================================================ */

// Cache token di memory (shared antar request di instance yang sama)
let cachedToken = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 menit

const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";

// ============================================================
//  SCRAPE TOKEN FRESH DARI BUNDLE JS
// ============================================================
async function scrapeToken() {
  console.log("[ig-token] Scraping fresh token...");
  const BASE = "https://savefromins.com";

  try {
    const htmlRes = await fetch(BASE + "/", {
      headers: { "user-agent": UA },
    });
    const html = await htmlRes.text();

    const jsUrls = [];
    const regex = /<script[^>]+src="([^"]+)"/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      let u = m[1];
      if (!u.startsWith("http")) {
        u = BASE + (u.startsWith("/") ? "" : "/") + u;
      }
      jsUrls.push(u);
    }

    console.log(`[ig-token] Found ${jsUrls.length} JS files`);

    // Pattern token: 2025xxxx + 8+ char alphanumeric
    const patterns = [
      /auth["']?\s*[:=]\s*["'](2025\d{4}[a-z0-9]{6,})["']/i,
      /["'](2025\d{4}[a-z0-9]{6,})["']/i,
      /(2025\d{4}[a-z0-9]{6,})/i,
    ];

    for (const u of jsUrls) {
      try {
        const jsRes = await fetch(u, {
          headers: { "user-agent": UA },
          signal: AbortSignal.timeout(5000),
        });
        const js = await jsRes.text();

        for (const p of patterns) {
          const match = js.match(p);
          if (match && match[1]) {
            console.log(`[ig-token] ✓ Found: ${match[1]}`);
            return match[1];
          }
        }
      } catch (e) {
        // skip file ini, lanjut ke berikutnya
      }
    }
  } catch (e) {
    console.warn("[ig-token] Scrape error:", e.message);
  }

  console.warn("[ig-token] ✗ Scrape gagal, pakai fallback");
  return null;
}

// ============================================================
//  GET TOKEN — pakai cache, refresh kalau expired
// ============================================================
async function getToken(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && cachedToken && (now - cachedAt) < CACHE_TTL) {
    console.log("[ig-token] Pakai cached token");
    return cachedToken;
  }

  const fresh = await scrapeToken();
  if (fresh) {
    cachedToken = fresh;
    cachedAt = now;
    return fresh;
  }

  // Fallback: pakai token hardcoded kalau scrape gagal
  if (cachedToken) {
    console.log("[ig-token] Scrape gagal, pakai token lama");
    return cachedToken;
  }

  console.log("[ig-token] Scrape gagal, pakai hardcoded fallback");
  cachedToken = "20250901majwlqo";
  cachedAt = now;
  return cachedToken;
}

// ============================================================
//  CALL API PARSE
// ============================================================
async function parseIg(igUrl, token) {
  const body = new URLSearchParams({
    auth: token,
    domain: "api-ak.savefromins.com",
    origin: "source",
    link: igUrl,
  });

  const r = await fetch("https://api.savefromins.com/api/contentsite_api/media/parse", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "origin": "https://savefromins.com",
      "referer": "https://savefromins.com/",
      "user-agent": UA,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });

  const data = await r.json();
  return { status: r.status, data };
}

// ============================================================
//  HANDLER
// ============================================================
module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const igUrl = req.query.url;
  if (!igUrl) {
    return res.status(400).json({ status: false, error: "Parameter 'url' wajib diisi" });
  }

  try {
    // --- Attempt 1: pakai token (cached / fresh) ---
    let token = await getToken();
    let result = await parseIg(igUrl, token);

    // --- Kalau gagal → force re-scrape token & retry sekali ---
    if (result.data.status_code !== "success") {
      console.log("[ig] Attempt 1 gagal, refresh token & retry...");
      token = await getToken(true);
      result = await parseIg(igUrl, token);
    }

    // --- Masih gagal → return error ---
    if (result.data.status_code !== "success") {
      return res.status(502).json({
        status: false,
        error: result.data.msg || "Gagal parse Instagram",
        token_used: token ? token.slice(0, 12) + "..." : null,
      });
    }

    return res.status(200).json({
      status: true,
      data: result.data.data,
    });
  } catch (e) {
    console.error("[ig] Error:", e);
    return res.status(500).json({ status: false, error: e.message });
  }
};
