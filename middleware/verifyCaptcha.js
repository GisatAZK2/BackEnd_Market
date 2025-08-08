// middlewares/verifyCaptcha.js
const axios = require("axios");

const verifyCaptcha = async (req, res, next) => {
  const token = req.body.captchaToken;

  if (!token) {
    return res
      .status(400)
      .json({ success: false, message: "Token CAPTCHA tidak ditemukan." });
  }

  try {
    const response = await axios.post(
      "https://www.google.com/recaptcha/api/siteverify",
      null,
      {
        params: {
          secret: process.env.RECAPTCHA_SECRET_KEY,
          response: token,
          remoteip: req.ip, // opsional, kasih IP buat keamanan tambahan
        },
      },
    );

    const captchaData = response.data;

    if (!captchaData.success) {
      // Bisa log error codes buat debugging
      console.warn("CAPTCHA error codes:", captchaData["error-codes"]);

      return res.status(403).json({
        success: false,
        message: "Verifikasi CAPTCHA gagal.",
        errors: captchaData["error-codes"] || [],
      });
    }

    next(); // lolos CAPTCHA, lanjut
  } catch (err) {
    console.error("CAPTCHA verification error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat verifikasi CAPTCHA.",
    });
  }
};

module.exports = verifyCaptcha;
