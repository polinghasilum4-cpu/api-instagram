// language: JavaScript (Node 20), file: upload.js
// Usage: node upload.js <file>

const fs = require('fs');
const path = require('path');

const MIME = {
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png',
  '.gif':'image/gif', '.webp':'image/webp', '.mp4':'video/mp4',
  '.mp3':'audio/mpeg', '.pdf':'application/pdf', '.zip':'application/zip',
};

const file = process.argv[2];
if (!file) { console.log('Usage: node upload.js <file>'); process.exit(1); }
if (!fs.existsSync(file)) { console.log('File tidak ditemukan.'); process.exit(1); }

const stat = fs.statSync(file);
const ext = path.extname(file).toLowerCase();
const mime = MIME[ext] || 'application/octet-stream';

console.log(`[i] ${path.basename(file)} (${(stat.size / 1024 / 1024).toFixed(2)} MB, ${mime})`);

// Coba openAsBlob (stream dari disk), fallback ke readFileSync
async function makeBody() {
  if (typeof fs.openAsBlob === 'function') {
    try { return await fs.openAsBlob(file, { type: mime }); } catch (_) {}
  }
  return new Blob([fs.readFileSync(file)], { type: mime });
}

(async () => {
  try {
    const blob = await makeBody();
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('userhash', '');
    form.append('fileToUpload', blob, path.basename(file));

    const t0 = Date.now();
    const res = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      body: form,
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        'origin': 'https://catbox.moe',
        'referer': 'https://catbox.moe/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });

    const text = (await res.text()).trim();
    const dt = ((Date.now() - t0) / 1000).toFixed(2);

    if (!res.ok) {
      console.log(`[!] Gagal ${res.status} (${dt}s): ${text.slice(0, 300)}`);
      process.exit(1);
    }
    if (!/^https?:\/\//i.test(text)) {
      console.log(`[!] Response bukan URL (${dt}s): ${text.slice(0, 300)}`);
      process.exit(1);
    }

    console.log(`[✓] ${dt}s`);
    console.log(text);
  } catch (e) {
    console.log('[!] Upload gagal:', e.message);
    process.exit(1);
  }
})();
