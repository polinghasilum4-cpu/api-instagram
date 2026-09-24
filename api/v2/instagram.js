/* Instagram Downloader API — by xs0ciety
   Proxy ke api.downloadgram.app/dp
   Endpoint: GET /api/v2/instagram?url=<instagram_url>
   Debug:    GET /api/v2/instagram?url=<url>&debug=1
*/

const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";

// Decode semua escape karakter dari HTML
function decodeHtml(html) {
  return html
    .replace(/\\x2F/g, "/")
    .replace(/\\x3A/g, ":")
    .replace(/\\x3F/g, "?")
    .replace(/\\x3D/g, "=")
    .replace(/\\x26/g, "&")
    .replace(/\\x22/g, '"')
    .replace(/\\x27/g, "'")
    .replace(/\\x20/g, " ")
    .replace(/\\x3C/g, "<")
    .replace(/\\x3E/g, ">")
    .replace(/\\u002F/g, "/")
    .replace(/\\u003A/g, ":")
    .replace(/\\u003F/g, "?")
    .replace(/\\u003D/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/\\/g, "");
}

// Extract semua URL dari HTML (yang udah di-decode)
function extractAllUrls(decoded) {
  const urls = new Set();

  const patterns = [
    /https?:\/\/cdn\.downloadgram\.app\/[^\s"'<>]+/g,
    /https?:\/\/[^\s"'<>]*\.mp4[^\s"'<>]*/g,
    /https?:\/\/[^\s"'<>]*\.jpg[^\s"'<>]*/g,
    /https?:\/\/[^\s"'<>]*\.webp[^\s"'<>]*/g,
    /https?:\/\/scontent[^\s"'<>]+/g,
    /https?:\/\/[^\s"'<>]*cdninstagram\.com[^\s"'<>]*/g,
  ];

  for (const p of patterns) {
    const matches = decoded.match(p) || [];
    matches.forEach(u => {
      // Bersihin karakter sisa
      const clean = u.replace(/[\\"'<>]+$/, "").trim();
      if (clean.length > 20) urls.add(clean);
    });
  }

  return [...urls];
}

// Extract thumbnail
function extractThumbnail(decoded) {
  const patterns = [
    /<img\s+src="([^"]+)"/i,
    /property="og:image"\s+content="([^"]+)"/i,
    /"thumbnail"\s*:\s*"([^"]+)"/i,
  ];
  for (const p of patterns) {
    const m = decoded.match(p);
    if (m && m[1] && m[1].startsWith("http")) return m[1];
  }
  return null;
}

// Deteksi video vs image
function isVideo(url) {
  const lower = url.toLowerCase();
  return lower.includes(".mp4")
      || lower.includes("video")
      || lower.includes("reel")
      || lower.includes("t50.2886")
      || lower.includes("dash")
      || lower.includes("play");
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const igUrl = req.query.url;
  const debug = req.query.debug === "1";

  if (!igUrl) {
    return res.status(400).json({ status: false, error: "Parameter 'url' wajib diisi" });
  }

  if (!igUrl.includes("instagram.com")) {
    return res.status(400).json({ status: false, error: "URL harus dari Instagram" });
  }

  try {
    const body = new URLSearchParams({
      url: igUrl,
      lang: "id",
    });

    const r = await fetch("https://api.downloadgram.app/dp", {
      method: "POST",
      headers: {
        "accept": "*/*",
        "content-type": "application/x-www-form-urlencoded",
        "origin": "https://www.downloadgram.app",
        "referer": "https://www.downloadgram.app/",
        "user-agent": UA,
        "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });

    console.log("[ig] Upstream status:", r.status);

    const html = await r.text();
    const decoded = decodeHtml(html);
    const allUrls = extractAllUrls(decoded);
    const thumbnail = extractThumbnail(decoded);

    // ---- DEBUG MODE ----
    if (debug) {
      return res.status(200).json({
        status: true,
        debug: true,
        upstream_status: r.status,
        raw_html_length: html.length,
        decoded_length: decoded.length,
        urls_found: allUrls,
        thumbnail: thumbnail,
        raw_html_preview: html.slice(0, 5000),
        decoded_preview: decoded.slice(0, 5000),
      });
    }

    // ---- NORMAL MODE ----
    if (allUrls.length === 0) {
      return res.status(502).json({
        status: false,
        error: "Gagal extract download URL",
        decoded_preview: decoded.slice(0, 3000),
      });
    }

    // Pisahkan video vs image
    const videos = allUrls.filter(u => isVideo(u));
    const images = allUrls.filter(u => !isVideo(u) && !u.includes("profile"));

    // Prioritaskan video kalau ada
    const resources = [
      ...videos.map(u => ({ download_url: u, format: "mp4" })),
      ...images.map(u => ({ download_url: u, format: "jpg" })),
    ];

    // Kalau gak ada video, cuma image → itu normal buat post foto
    return res.status(200).json({
      status: true,
      data: {
        title: "Instagram Media",
        username: "unknown",
        like_count: 0,
        comment_count: 0,
        thumbnail: thumbnail,
        total_found: allUrls.length,
        video_count: videos.length,
        image_count: images.length,
        resources: resources,
      },
    });
  } catch (e) {
    console.error("[ig] Error:", e);
    return res.status(500).json({ status: false, error: e.message });
  }
};
