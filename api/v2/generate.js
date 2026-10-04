const QRCode = require('qrcode');
const validator = require('validator');

module.exports = async (req, res) => {
  // Atur header CORS agar API bisa diakses dari web Anda
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Menangani preflight request dari browser
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Hanya izinkan method POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      status: 'error',
      message: 'Method tidak diizinkan. Gunakan POST!'
    });
  }

  try {
    let { link, qrTitle } = req.body || {};

    // Validasi input
    if (!link || typeof link !== 'string') {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Parameter "link" wajib diisi!' 
      });
    }

    link = link.trim();

    // Validasi format URL
    if (!validator.isURL(link, { require_protocol: true })) {
      return res.status(400).json({
        status: 'error',
        message: 'URL tidak valid! Wajib menyertakan http:// atau https://'
      });
    }

    // Generate QR Code ke bentuk Base64 Data URL
    const qrDataUrl = await QRCode.toDataURL(link, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      margin: 2,
      width: 300
    });

    return res.status(200).json({
      status: 'success',
      title: qrTitle || 'QR Code',
      target_link: link,
      qr_image: qrDataUrl
    });

  } catch (error) {
    return res.status(500).json({ 
      status: 'error', 
      message: 'Gagal membuat QR Code', 
      detail: error.message 
    });
  }
};
