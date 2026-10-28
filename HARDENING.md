# xs0ciety API Hardening

## What was applied
- Strict Origin allowlist: only https://xs0cietylabsz.biz.id
- Required header: X-XS-Key
- Bot / scraper User-Agent blocking
- Removed Access-Control-Allow-Origin: *
- Security headers (X-Content-Type-Options, X-Frame-Options, etc.)

## Required setup
1. Vercel → Settings → Environment Variables
   XS_API_SECRET = (long random string, min 32 chars)

2. Frontend every fetch must send:
   headers: {
     "Content-Type": "application/json",
     "X-XS-Key": "THE_SAME_SECRET"
   }

3. Redeploy after setting env var.
