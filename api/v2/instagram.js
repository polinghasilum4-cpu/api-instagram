/* Instagram Downloader API — by xs0ciety
   Auto-scrape token dari savefromins.com
   Endpoint: GET /api/v2/instagram?url=<instagram_url>
*/

const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";
const BASE = "https://savefromins.com";

// Cache token di memory
let cachedToken = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 menit

// ============================================================
//  SCRAPE TOKEN DARI JS BUNDLE
// ============================================================
async function scrapeToken() {
  console.log("[ig] Scrape token...");
  try {
    const htmlRes = await fetch(BASE + "/", {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    const html = await htmlRes.text();

    // Kumpulkan URL script
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

    console.log(`[ig] Found ${jsUrls.length} JS files`);

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
            console.log(`[ig] ✓ Token: ${match[1]}`);
            return match[1];
          }
        }
      } catch (e) {
        // skip file ini
      }
    }
  } catch (e) {
    console.warn("[ig] Scrape error:", e.message);
  }

  console.log("[ig] Scrape gagal, pakai fallback");
  return null;
}

// ============================================================
//  GET TOKEN (cache + fallback)
// ============================================================
async function getToken(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && cachedToken && (now - cachedAt) < CACHE_TTL) {
    return cachedToken;
  }

  const fresh = await scrapeToken();
  if (fresh) {
    cachedToken = fresh;
    cachedAt = now;
    return fresh;
  }

  if (cachedToken) return cachedToken;

  // Fallback hardcoded
  cachedToken = "20250901majwlqo";
  cachedAt = now;
  return cachedToken;
}

// ============================================================
//  PARSE IG
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
      "accept": "*/*",
      "content-type": "application/x-www-form-urlencoded",
      "origin": BASE,
      "referer": BASE + "/",
      "user-agent": UA,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });

  const text = await r.text();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch (e) {
    return { status: r.status, data: null, raw: text.slice(0, 500) };
  }
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
  if (!igUrl.includes("instagram.com")) {
    return res.status(400).json({ status: false, error: "URL harus dari Instagram" });
  }

  try {
    // Attempt 1
    let token = await getToken();
    let result = await parseIg(igUrl, token);

    // Attempt 2 — kalau gagal, refresh token & retry
    if (!result.data || result.data.status_code !== "success") {
      console.log("[ig] Attempt 1 gagal, refresh token...");
      token = await getToken(true);
      result = await parseIg(igUrl, token);
    }

    // Masih gagal
    if (!result.data || result.data.status_code !== "success") {
      return res.status(502).json({
        status: false,
        error: result.data?.msg || "Gagal parse Instagram",
        upstream_status: result.status,
        token_used: token ? token.slice(0, 12) + "..." : null,
        raw: result.raw || null,
      });
    }

    // Success — map ke format konsisten
    const info = result.data.data;
    let resources = info.resources || [];

    // Fallback ke info.media
    if (resources.length === 0 && Array.isArray(info.media)) {
      for (const m of info.media) {
        if (Array.isArray(m.resources)) resources.push(...m.resources);
      }
    }

    if (resources.length === 0) {
      return res.status(404).json({ status: false, error: "Tidak ada media ditemukan" });
    }

    const mapped = resources.map((r) => ({
      download_url: r.download_url,
      format: r.format || (r.download_url?.includes(".mp4") ? "mp4" : "jpg"),
      quality: r.quality || null,
      size: r.size || null,
    }));

    // Sort: video duluan
    mapped.sort((a, b) => (b.format === "mp4" ? 1 : -1));

    return res.status(200).json({
      status: true,
      data: {
        title: (info.title || "Instagram Media").trim().slice(0, 120),
        thumbnail: info.thumbnail || mapped[0]?.download_url || "",
        like_count: info.like_count || 0,
        comment_count: info.comment_count || 0,
        username: info.user_item?.nickname || "unknown",
        total: mapped.length,
        resources: mapped,
      },
    });
  } catch (e) {
    console.error("[ig] Error:", e);
    return res.status(500).json({ status: false, error: e.message });
  }
};
