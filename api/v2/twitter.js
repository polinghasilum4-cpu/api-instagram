/**
 * X2Twitter API — Vercel Serverless Function (Node.js)
 * ====================================================
 * GET  /api/download?url=<tweet_url>&lang=id
 * POST /api/download  {"url": "...", "lang": "id"}
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');


// ======================================================================
// Config
// ======================================================================
const BASE_URL = 'https://x2twitter.com';
const API_VERIFY = `${BASE_URL}/api/userverify`;
const API_SEARCH = `${BASE_URL}/api/ajaxSearch`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': BASE_URL,
  'Referer': `${BASE_URL}/id3`,
  'sec-ch-ua': '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};


// ======================================================================
// Client (singleton, di-reuse antar warm invocation)
// ======================================================================
class X2Twitter {
  constructor() {
    this.jar = new CookieJar();
    this.client = wrapper(
      axios.create({
        jar: this.jar,
        headers: HEADERS,
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
      })
    );
    this.warmedUp = false;
    this.cftoken = null;
  }

  static validateUrl(url) {
    const pattern = /^https?:\/\/(www\.)?(x\.com|twitter\.com|mobile\.twitter\.com|mobile\.x\.com)\/[^/]+\/status\/\d+/i;
    if (!pattern.test(url)) {
      throw new Error(
        "URL tidak valid. Harus link tweet, contoh: https://x.com/user/status/1234567890"
      );
    }
    return url;
  }

  async warmUp() {
    if (this.warmedUp) return;

    const res = await this.client.get(`${BASE_URL}/id3`);
    if (typeof res.data === 'string') {
      const m = res.data.match(/"cftoken"\s*:\s*"([^"]+)"/);
      if (m) this.cftoken = m[1];
    }
    this.warmedUp = true;
  }

  async userVerify(tweetUrl) {
    await this.warmUp();

    const body = new URLSearchParams({ url: tweetUrl }).toString();
    const res = await this.client.post(API_VERIFY, body);

    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const token = data.cftoken || data.token;
    if (token) this.cftoken = token;
    return token;
  }

  async ajaxSearch(tweetUrl, lang = 'id') {
    if (!this.cftoken) throw new Error('cftoken belum ada');

    const body = new URLSearchParams({
      q: tweetUrl,
      lang,
      cftoken: this.cftoken,
    }).toString();

    const res = await this.client.post(API_SEARCH, body);
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  }

  static parseResult(html) {
    if (!html) return null;

    const result = {
      title: null,
      duration: null,
      thumbnail: null,
      twitter_id: null,
      medias: [],
      mp3: null,
      k_exp: null,
      k_token: null,
    };

    let m;

    m = html.match(/<h3>([\s\S]*?)<\/h3>/);
    if (m) result.title = m[1].trim();

    m = html.match(/<p>(\d+:\d+)<\/p>/);
    if (m) result.duration = m[1];

    m = html.match(/<img src="([^"]+)"/);
    if (m) result.thumbnail = m[1];

    m = html.match(/id="TwitterId"\s+value="(\d+)"/);
    if (m) result.twitter_id = m[1];

    const re = /<a[^>]+href="(https:\/\/dl\.snapcdn\.app\/get\?token=[^"]+)"[^>]*>[\s\S]*?<i class="icon icon-[^"]+"><\/i>\s*([^<]+)<\/a>/g;
    let match;
    while ((match = re.exec(html)) !== null) {
      result.medias.push({
        label: match[2].trim(),
        url: match[1],
      });
    }

    m = html.match(/data-audioUrl="([^"]+)"/);
    if (m) result.mp3 = m[1];

    m = html.match(/k_exp\s*=\s*"(\d+)"/);
    if (m) result.k_exp = m[1];

    m = html.match(/k_token\s*=\s*"([a-f0-9]+)"/);
    if (m) result.k_token = m[1];

    return result;
  }

  async download(tweetUrl, lang = 'id') {
    X2Twitter.validateUrl(tweetUrl);

    let token = await this.userVerify(tweetUrl);
    if (!token) {
      this.warmedUp = false;
      token = await this.userVerify(tweetUrl);
    }

    const raw = await this.ajaxSearch(tweetUrl, lang);
    if (!raw || raw.status !== 'ok') return null;

    const html = raw.data;
    if (!html) return null;

    return X2Twitter.parseResult(html);
  }
}


// ======================================================================
// Singleton cache
// ======================================================================
let _client = null;
function getClient() {
  if (!_client) _client = new X2Twitter();
  return _client;
}


// ======================================================================
// CORS helper
// ======================================================================
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}


// ======================================================================
// Handler (Vercel Node.js)
// ======================================================================
module.exports = async function handler(req, res) {
  cors(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Ambil URL dari query atau body
  let url = req.query.url;
  let lang = req.query.lang || 'id';

  if (!url && req.body) {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    url = body.url;
    lang = body.lang || lang;
  }

  // Health check
  if (!url) {
    return res.status(200).json({
      success: true,
      service: 'x2twitter-api',
      status: 'ok',
      usage: {
        GET: '/api/download?url=<tweet_url>&lang=id',
        POST: '{"url": "...", "lang": "id"}',
      },
    });
  }

  // Validasi
  try {
    X2Twitter.validateUrl(url);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }

  // Proses
  try {
    const client = getClient();
    const result = await client.download(url, lang);

    if (!result) {
      return res.status(502).json({ success: false, error: 'Gagal mengambil data dari sumber' });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (e) {
    console.error('Error:', e.message);
    return res.status(502).json({ success: false, error: `Upstream error: ${e.message}` });
  }
};
