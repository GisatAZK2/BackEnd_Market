// routes/authSeller.js
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const supabase = require("../../config/supabase"); // pastikan path sesuai
const detectSpam = require("../../middleware/detectSpam");
const verifyCaptcha = require("../../middleware/verifyCaptcha");
const router = express.Router();

// ======================== VERIFY OTP ========================
router.post("/verify-otp", detectSpam, verifyCaptcha, async (req, res) => {
  const { email, otp, mode = "email" } = req.body;

  try {
    // === Cek user ===
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (userErr || !user) {
      return res
        .status(404)
        .json({ success: false, message: "User tidak ditemukan." });
    }

    const now = new Date().toISOString();
    if (user.otp_code !== otp || user.otp_expires_at <= now) {
      return res
        .status(400)
        .json({ success: false, message: "OTP salah atau kadaluarsa." });
    }

    // === Update verified ===
    const { error: updateErr } = await supabase
      .from("users")
      .update({
        verified: true,
        otp_code: null,
        otp_expires_at: null,
      })
      .eq("email", email);

    if (updateErr) throw updateErr;

    // === Hanya Google yang login otomatis ===
    if (mode === "google") {
      const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });

      // === Cek apakah sudah seller ===
      const { data: seller } = await supabase
        .from("sellers")
        .select("*")
        .eq("email", user.email)
        .single();

      if (!seller) {
        return res.json({
          success: true,
          step: "register_seller",
          message: "OTP valid. Akun diaktifkan. Harap daftar sebagai seller.",
        });
      }

      // Set cookie seller_info
      res.cookie(
        "seller_info",
        JSON.stringify({
          id: seller.id,
          email: seller.email,
          store_name: seller.store_name,
        }),
        {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "None",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        },
      );

      return res.json({
        success: true,
        step: "redirect_dashboard",
        message: "OTP valid. Akun diaktifkan & login otomatis.",
        token,
        id: user.id,
      });
    }

    return res.json({
      success: true,
      step: "login_manual",
      message: "OTP valid. Akun diaktifkan. Silakan login manual.",
    });
  } catch (err) {
    console.error("OTP Error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Terjadi kesalahan pada server." });
  }
});

// ======================== LOGIN SELLER ========================
router.post("/login", detectSpam, verifyCaptcha, async (req, res) => {
  const { email, password } = req.body;

  try {
    // Cek user
    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (!user || !user.verified) {
      return res
        .status(403)
        .json({ error: "Akun tidak ditemukan atau belum diverifikasi." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Password salah." });

    // Cek apakah sudah terdaftar sebagai seller
    const { data: seller } = await supabase
      .from("sellers")
      .select("*")
      .eq("email", email)
      .single();

    if (!seller) {
      return res.status(403).json({
        error: "Harap daftar sebagai seller terlebih dahulu.",
      });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    // Set cookie user_info
    res.cookie(
      "user_info",
      JSON.stringify({
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
      }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "None",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    );

    // Set cookie seller_info
    res.cookie(
      "seller_info",
      JSON.stringify({
        id: seller.id,
        email: seller.email,
        store_name: seller.store_name,
      }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "None",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    );

    res.json({
      message: "Login seller sukses.",
      token,
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar,
      seller_id: seller.id,
      store_name: seller.store_name,
    });
  } catch (err) {
    console.error("Login seller error:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
});

module.exports = router;
