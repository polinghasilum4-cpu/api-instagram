/**
 * Catbox Upload — Vercel Edge Runtime
 * ====================================
 * Runtime: edge (Cloudflare network, bukan AWS Lambda)
 * IP-nya beda dari serverless function biasa
 */

export const config = { runtime: 'edge' };

const CATBOX_URL = 'https://catbox.moe/user/api.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const MAX_SIZE = 4 * 1024 * 1024; // Edge Function body limit 4MB

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Filename, X-Requested-With',
    };
}

function jsonResponse(payload, status) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders(),
        },
    });
}

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
        return jsonResponse({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Hanya POST yang diizinkan' } }, 405);
    }

    console.log('[catbox] incoming request');

    try {
        const url = new URL(request.url);
        let filename = url.searchParams.get('filename') || request.headers.get('x-filename') || 'file';
        filename = String(filename).replace(/[^\w\-. ]/g, '_').slice(0, 100) || 'file';

        const bodyBuffer = await request.arrayBuffer();
        if (!bodyBuffer || bodyBuffer.byteLength === 0) {
            return jsonResponse({ ok: false, error: { code: 'EMPTY_FILE', message: 'Body kosong' } }, 400);
        }
        if (bodyBuffer.byteLength > MAX_SIZE) {
            return jsonResponse({ ok: false, error: { code: 'FILE_TOO_LARGE', message: `Kebesaran (${bodyBuffer.byteLength} bytes, max ${MAX_SIZE})` } }, 413);
        }

        console.log(`[catbox] ${filename} (${bodyBuffer.byteLength} bytes)`);

        // Build multipart manual (Web API)
        const boundary = '----WebKitFormBoundary' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const CRLF = '\r\n';
        const encoder = new TextEncoder();
        const safeName = filename.replace(/[\r\n"\\]/g, '_');

        const head = encoder.encode(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="reqtype"${CRLF}${CRLF}` +
            `fileupload${CRLF}` +
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="userhash"${CRLF}${CRLF}${CRLF}` +
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="fileToUpload"; filename="${safeName}"${CRLF}` +
            `Content-Type: application/octet-stream${CRLF}${CRLF}`
        );
        const tail = encoder.encode(`${CRLF}--${boundary}--${CRLF}`);

        const full = new Uint8Array(head.byteLength + bodyBuffer.byteLength + tail.byteLength);
        full.set(head, 0);
        full.set(new Uint8Array(bodyBuffer), head.byteLength);
        full.set(tail, head.byteLength + bodyBuffer.byteLength);

        const catRes = await fetch(CATBOX_URL, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,id;q=0.7',
                'Cache-Control': 'no-cache',
                'Origin': 'https://catbox.moe',
                'Referer': 'https://catbox.moe/',
                'User-Agent': UA,
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: full,
        });

        const text = (await catRes.text()).trim();
        console.log(`[catbox] upstream ${catRes.status} ${text.slice(0, 150)}`);

        if (catRes.status !== 200) {
            return jsonResponse({
                ok: false,
                error: {
                    code: 'UPSTREAM_ERROR',
                    message: `Catbox HTTP ${catRes.status}`,
                    raw: text.slice(0, 300),
                },
            }, catRes.status >= 400 && catRes.status < 500 ? catRes.status : 502);
        }

        if (!/^https?:\/\//i.test(text)) {
            return jsonResponse({
                ok: false,
                error: { code: 'UPSTREAM_INVALID', message: 'Catbox tidak return URL valid', raw: text.slice(0, 300) },
            }, 502);
        }

        return jsonResponse({
            ok: true,
            data: {
                url: text,
                filename,
                size: bodyBuffer.byteLength,
                expires: 'Permanent',
            },
        }, 200);

    } catch (err) {
        console.error('[catbox] fatal:', err.message);
        return jsonResponse({ ok: false, error: { code: 'INTERNAL', message: err.message || 'Internal error' } }, 500);
    }
            }
