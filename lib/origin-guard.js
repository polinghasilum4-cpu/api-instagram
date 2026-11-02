/* ============================================================
 *  origin guard — cuma web https://xs0cietylabsz.biz.id yang boleh
 *  Dipanggil di awal handler: if (!guard(req, res)) return;
 * ============================================================ */

const ALLOWED_ORIGINS = [
  "https://xs0cietylabsz.biz.id",
  "https://www.xs0cietylabsz.biz.id",
];

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

module.exports = function originGuard(req, res) {
  const origin = req.headers.origin;
  const referer = req.headers.referer || req.headers.referrer;

  let ok = false;
  if (origin) {
    ok = ALLOWED_ORIGINS.includes(origin);
  } else if (referer) {
    ok = ALLOWED_ORIGINS.includes(originOf(referer));
  }

  if (ok) return true;

  res.statusCode = 403;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({
    error: "Forbidden",
    message: "API ini hanya bisa diakses dari https://xs0cietylabsz.biz.id",
  }));
  return false;
};
