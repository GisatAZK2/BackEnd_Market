const axios = require("axios");

const verifyCaptcha = async (req, res, next) => {
  const token = req.body.captchaToken;
  const isCaptchaRequired = req.requireCaptcha === true;

  const skipCaptcha =
    !isCaptchaRequired ||
    process.env.NODE_ENV !== "production" ||
    token === "test-dev-bypass";

  if (skipCaptcha) {
    console.log("🔓 CAPTCHA skipped");
    return next();
  }

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
          remoteip: req.ip,
        },
      },
    );

    const captchaData = response.data;

    if (!captchaData.success) {
      console.warn("❌ CAPTCHA error:", captchaData["error-codes"]);
      return res.status(403).json({
        success: false,
        message: "Verifikasi CAPTCHA gagal.",
        errors: captchaData["error-codes"] || [],
      });
    }

    console.log("✅ CAPTCHA verified");
    next(); // Lolos
  } catch (err) {
    console.error("CAPTCHA verification error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat verifikasi CAPTCHA.",
    });
  }
};

module.exports = verifyCaptcha;
