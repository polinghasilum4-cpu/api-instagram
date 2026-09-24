/* Instagram Downloader API — by xs0ciety
   Proxy ke api.downloadgram.app/dp
   Endpoint: GET /api/v2/instagram?url=<instagram_url>
*/

const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";

// Extract URL cdn.downloadgram.app + token
function extractDownloadUrls(html) {
  const urls = new Set();

  // Pattern 1: URL mentah di HTML (src="..." atau href="...")
  const rawPattern = /https?:\/\/cdn\.downloadgram\.app\/\?token=[A-Za-z0-9\-_.]+/g;
  const rawMatches = html.match(rawPattern) || [];
  rawMatches.forEach(u => urls.add(u.replace(/\\x2F/g, "/").replace(/\\/g, "")));

  // Pattern 2: URL dalam bentuk escaped (\\x22, \\x2F, dll)
  const escapedPattern = /https?:\\x2F\\x2Fcdn\.downloadgram\.app\\x2F\?token=[A-Za-z0-9\-_.\\x]+/g;
  const escapedMatches = html.match(escapedPattern) || [];
  escapedMatches.forEach(u => {
    const clean = u
      .replace(/\\x2F/g, "/")
      .replace(/\\x3A/g, ":")
      .replace(/\\x3F/g, "?")
      .replace(/\\x3D/g, "=")
      .replace(/\\x22/g, "")
      .replace(/\\/g, "");
    urls.add(clean);
  });

  return [...urls];
}

// Extract thumbnail dari HTML
function extractThumbnail(html) {
  const m = html.match(/<img\s+src=\\x22(https?:[^\\]+)\\x22/);
  if (m) {
    return m[1].replace(/\\x2F/g, "/").replace(/\\x3A/g, ":").replace(/\\/g, "");
  }
  return null;
}

module.exports = async (req, res) => {
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

    const downloadUrls = extractDownloadUrls(html);
    const thumbnail = extractThumbnail(html);

    if (downloadUrls.length === 0) {
      return res.status(502).json({
        status: false,
        error: "Gagal extract download URL dari response",
        raw: html.slice(0, 800),
      });
    }

    // Dedupe — kalau ada mp4 & jpg, priority mp4
    const resources = downloadUrls.map(u => {
      const isVideo = u.includes(".mp4") || u.includes("video");
      return {
        download_url: u,
        format: isVideo ? "mp4" : "jpg",
      };
    });

    // Kalau ada beberapa, yang mp4 duluan
    resources.sort((a, b) => (b.format === "mp4" ? 1 : -1));

    // Coba extract username dari HTML
    const usernameMatch = html.match(/@([a-zA-Z0-9._]+)/);
    const username = usernameMatch ? usernameMatch[1] : "unknown";

    return res.status(200).json({
      status: true,
      data: {
        title: "Instagram Media",
        username: username,
        like_count: 0,
        comment_count: 0,
        thumbnail: thumbnail,
        resources: resources,
      },
    });
  } catch (e) {
    console.error("[ig] Error:", e);
    return res.status(500).json({ status: false, error: e.message });
  }
};
