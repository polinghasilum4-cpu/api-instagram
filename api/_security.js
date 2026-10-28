/**
 * xs0ciety API Security Layer
 * Only allows: https://xs0cietylabsz.biz.id
 */
const ALLOWED_ORIGINS = [
  "https://xs0cietylabsz.biz.id",
  "https://www.xs0cietylabsz.biz.id",
];

// Set this in Vercel Environment Variables: XS_API_SECRET
const API_SECRET = process.env.XS_API_SECRET || "xs0ciety_CHANGE_ME_TO_LONG_RANDOM_SECRET_32chars";

const BLOCKED_UA = [
  /telegram/i, /whatsapp/i, /bot\b/i, /curl\//i, /wget\//i,
  /python-requests/i, /scrapy/i, /httpclient/i, /go-http-client/i,
  /java\//i, /libwww/i, /postman/i, /insomnia/i, /httpie/i
];

function getOrigin(req) {
  return (req.headers.origin || req.headers.referer || "").toString();
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const normalized = origin.split("?")[0].replace(/\/$/, "");
    return ALLOWED_ORIGINS.some((allowed) => {
      return normalized === allowed || normalized.startsWith(allowed + "/");
    });
  } catch {
    return false;
  }
}

/**
 * Returns true if request was blocked (response already sent)
 * Returns false if request is allowed (continue processing)
 */
function securityCheck(req, res) {
  const origin = req.headers.origin || "";

  // CORS headers
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // Still set a restrictive default
    res.setHeader("Access-Control-Allow-Origin", "https://xs0cietylabsz.biz.id");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-XS-Key, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");

  // Preflight
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }

  // Strict Origin / Referer check
  const reqOrigin = getOrigin(req);
  if (!isAllowedOrigin(reqOrigin)) {
    res.status(403).json({ status: false, message: "Forbidden" });
    return true;
  }

  // Secret key check
  const key = (req.headers["x-xs-key"] || "").toString().trim();
  if (!key || key !== API_SECRET) {
    res.status(401).json({ status: false, message: "Unauthorized" });
    return true;
  }

  // Block common bots / scrapers
  const ua = (req.headers["user-agent"] || "").toString();
  if (!ua || BLOCKED_UA.some((r) => r.test(ua))) {
    res.status(403).json({ status: false, message: "Forbidden" });
    return true;
  }

  return false; // allowed
}

module.exports = { securityCheck, ALLOWED_ORIGINS, API_SECRET };
