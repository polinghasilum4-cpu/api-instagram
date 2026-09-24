/* Instagram Downloader API — by xs0ciety
   Proxy ke api.downloadgram.app/dp
   Endpoint: GET /api/v2/instagram?url=<instagram_url>
*/

const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";

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

    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({
        status: false,
        error: "Response upstream bukan JSON",
        raw: text.slice(0, 500),
      });
    }

    return res.status(200).json({
      status: true,
      upstream: data,
    });
  } catch (e) {
    console.error("[ig] Error:", e);
    return res.status(500).json({ status: false, error: e.message });
  }
};
