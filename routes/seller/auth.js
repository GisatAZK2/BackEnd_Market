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
    // Cek user untuk autentikasi
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

    if (!user.password) {
      return res.status(400).json({ error: "Password user belum diatur." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Password salah." });

    // Cek data seller
    let { data: seller } = await supabase
      .from("sellers")
      .select("*")
      .eq("email", email)
      .single();

    // Jika belum ada seller, buat otomatis
    if (!seller) {
      const { data: newSeller, error: sellerError } = await supabase
        .from("sellers")
        .insert([
          {
            email,
            store_name: user.username || "Toko Baru",
            store_image_url: null,
            phone: user.phone || null
          }
        ])
        .select()
        .single();

      if (sellerError) {
        console.error("Gagal membuat seller:", sellerError);
        return res.status(500).json({ error: "Gagal membuat data seller." });
      }

      seller = newSeller;
    }

    // Token tetap berdasarkan user.id
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    // Cookie seller_info
    res.cookie(
      "seller_info",
      JSON.stringify({
        id: seller.id,
        email: seller.email,
        store_name: seller.store_name,
      }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production" ? true : false,
        sameSite: "None",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      }
    );

    res.json({
      message: "Login seller sukses.",
      token,
      seller_id: seller.id,
      store_name: seller.store_name,
      profile_seller: seller.store_image_url,
      email: seller.email,
    });
  } catch (err) {
    console.error("Login seller error:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
});

router.get("/profile/:id", async (req, res) => {
  try {
    let sellerId;

    if (req.params.id) {
      // Ambil dari parameter URL
      sellerId = req.params.id;
    } else {
      // Ambil dari cookie jika parameter tidak diberikan
      const sellerCookie = req.cookies?.seller_info;
      if (!sellerCookie) {
        return res.status(401).json({ error: "Seller belum login." });
      }

      try {
        const sellerInfo = JSON.parse(sellerCookie);
        sellerId = sellerInfo.id;
      } catch (e) {
        return res.status(400).json({ error: "Cookie seller tidak valid." });
      }
    }

    // Query seller
    let { data: seller, error } = await supabase
      .from("sellers")
      .select(
        `id, name, business_name, email, phone, store_address, provinsi, kabupaten, kecamatan, kelurahan, created_at `
      )
      .eq("id", sellerId)
      .single();

    // Fallback ke versi lama jika kolom tidak ada
    if (error) {
      console.warn("Kolom default tidak ada, fallback ke versi lama:", error.message);
      const fallback = await supabase
        .from("sellers")
        .select(
          `id, store_name, store_image_url, email, phone, alamat_lengkap, provinsi, kota_kabupaten, kecamatan, kelurahan, kode_pos, created_at, updated_at`
        )
        .eq("id", sellerId)
        .single();

      seller = fallback.data;
      error = fallback.error;
    }

    if (error || !seller) {
      return res.status(404).json({ error: "Seller tidak ditemukan." });
    }

    // Gabungkan alamat
    const alamat_lengkap_combine = [
      seller.store_address,
      seller.kelurahan,
      seller.kecamatan,
      seller.kabupaten,
    ]
      .filter(Boolean)
      .join(", ");

    res.json({
      seller: {
        ...seller,
        alamat_lengkap_combine,
      },
    });
  } catch (err) {
    console.error("Get seller profile error:", err);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});


module.exports = router;
