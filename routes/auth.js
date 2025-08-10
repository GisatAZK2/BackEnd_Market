const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const supabase = require("../config/supabase");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");
const { generateOtp, sendPasswordResetEmail } = require("../utils/otp");
const detectSpam = require("../middleware/detectSpam");
const verifyCaptcha = require("../middleware/verifyCaptcha");
const fetch = require("node-fetch");

const router = express.Router();
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ======================== REGISTER ========================
router.post(
  "/register",
  detectSpam,
  upload.single("avatar"),
  verifyCaptcha,
  async (req, res) => {
    const { email, password, username } = req.body;
    console.log("Body register:", req.body);

    try {
      // === Cek user sudah ada atau belum ===
      const { data: existingUser } = await supabase
        .from("users")
        .select("*")
        .eq("email", email)
        .single();

      if (existingUser) {
        return res.status(400).json({
          error: "Email sudah digunakan. Silakan gunakan email lain.",
        });
      }

      // === Buat username final ===
      const finalUsername =
        username && username.trim() !== ""
          ? username.trim()
          : email.split("@")[0];

      const hashed = await bcrypt.hash(password, 10);
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      // === Avatar Handling ===
      let avatarPath;
      if (req.file) {
        // --- Kalau user upload avatar ---
        const filename = `avatar_${Date.now()}.webp`;

        // Konversi ke WebP dalam buffer
        const buffer = await sharp(req.file.buffer)
          .webp({ quality: 80 })
          .toBuffer();

        // Upload ke Supabase Storage
        const { error: uploadErr } = await supabase.storage
          .from("avatars")
          .upload(filename, buffer, {
            contentType: "image/webp",
            upsert: true,
          });

        if (uploadErr) {
          console.error("Upload error:", uploadErr);
          return res
            .status(500)
            .json({ error: "Gagal upload avatar ke storage." });
        }

        // Ambil public URL
        const { data: publicUrl } = supabase.storage
          .from("avatars")
          .getPublicUrl(filename);

        avatarPath = publicUrl.publicUrl;
      } else {
        // --- Kalau user TIDAK upload avatar ---
        const defaultImagePath = path.join(__dirname, "./assets/user.png");
        const filename = `avatar_default_${Date.now()}.webp`;

        // Konversi default.png ke WebP buffer
        const buffer = await sharp(defaultImagePath)
          .webp({ quality: 80 })
          .toBuffer();

        // Upload ke Supabase Storage
        const { error: uploadErr } = await supabase.storage
          .from("avatars")
          .upload(filename, buffer, {
            contentType: "image/webp",
            upsert: true,
          });

        if (uploadErr) {
          console.error("Upload default avatar error:", uploadErr);
          return res
            .status(500)
            .json({ error: "Gagal upload default avatar ke storage." });
        }

        // Ambil public URL
        const { data: publicUrl } = supabase.storage
          .from("avatars")
          .getPublicUrl(filename);

        avatarPath = publicUrl.publicUrl;
      }

      // === Simpan ke database ===
      const { error: insertErr } = await supabase.from("users").insert([
        {
          email,
          username: finalUsername,
          password: hashed,
          otp_code: otp,
          otp_expires_at: expiresAt,
          verified: false,
          avatar: avatarPath,
        },
      ]);

      if (insertErr) {
        console.error("Supabase insert error:", insertErr);
        return res
          .status(500)
          .json({ error: "Gagal membuat user di database." });
      }

      await generateOtp(email, otp);
      res.status(201).json({ message: "User dibuat. OTP dikirim ke email." });
    } catch (err) {
      console.error("Error saat register:", err);
      res.status(500).json({ error: "Terjadi kesalahan pada server." });
    }
  },
);

// ======================== VERIFIKASI OTP ========================
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

      res.cookie(
        "user_info",
        JSON.stringify({
          id: user.id,
          email: user.email,
          username: user.username,
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

    // === Email biasa tidak auto-login ===
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

// ======================== LOGIN ========================
router.post("/login", detectSpam, verifyCaptcha, async (req, res) => {
  const { email, password } = req.body;

  try {
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

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    // === Set cookie (httpOnly) ===
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

    // === Respon ke frontend (tambahkan avatar) ===
    res.json({
      message: "Login sukses.",
      token,
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar, // <---- avatar ikut dikirim
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
});

// ======================== LUPA PASSWORD ========================
router.post("/forgot-password", detectSpam, verifyCaptcha, async (req, res) => {
  const { email, resetLink } = req.body;

  try {
    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (!user) return res.status(404).json({ error: "Email tidak ditemukan." });

    const link =
      resetLink ||
      `https://cihuy.sytes.net/reset-password?email=${encodeURIComponent(email)}`;

    // Kirim email reset
    await sendPasswordResetEmail(email, link);

    res.json({ message: "Link reset password dikirim ke email." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
});

// lanjutan forgot password

// ======================== RESET PASSWORD ========================
router.post("/reset-password", detectSpam, verifyCaptcha, async (req, res) => {
  const { email, newPassword } = req.body;

  try {
    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (!user) return res.status(404).json({ error: "Email tidak ditemukan." });

    const hashed = await bcrypt.hash(newPassword, 10);
    const { error } = await supabase
      .from("users")
      .update({ password: hashed })
      .eq("email", email);

    if (error) {
      console.error("Supabase update error:", error);
      return res.status(500).json({ error: "Gagal mereset kata sandi." });
    }

    res.json({ message: "Kata sandi berhasil direset." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
});

// ======================== GET USER BY ID (Validasi Cookie) ========================
router.get("/user/:id", async (req, res) => {
  const cookie = req.cookies.user_info;
  if (!cookie) return res.status(401).json({ error: "Tidak ada sesi login." });

  let userInfo;
  try {
    userInfo = JSON.parse(cookie);
  } catch (e) {
    return res.status(400).json({ error: "Cookie tidak valid." });
  }

  if (userInfo.id !== req.params.id) {
    return res.status(403).json({ error: "Sesi login tidak valid." });
  }

  const { data: user, error } = await supabase
    .from("users")
    .select(
      `id, email, username, verified, avatar, provinsi, kota_kabupaten, kecamatan, kelurahan, kode_pos, nama_penerima, no_telepon, alamat_lengkap`,
    )
    .eq("id", req.params.id)
    .single();

  if (error || !user)
    return res.status(404).json({ error: "User tidak ditemukan." });

  // Gabungkan alamat
  const alamat_lengkap_combine = [
    user.alamat_lengkap,
    user.kelurahan,
    user.kecamatan,
    user.kota_kabupaten,
    user.kode_pos,
  ]
    .filter(Boolean) // buang yg falsy/null/undefined
    .join(", ");

  res.json({
    user: {
      ...user,
      alamat_lengkap_combine,
    },
  });
});

// ====================== UPDATE USER ======================
async function getWilayahName(url, id) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Gagal fetch data wilayah");
  const list = await res.json();
  const found = list.find((item) => item.id == id);
  if (!found) throw new Error(`Wilayah dengan id ${id} tidak ditemukan`);
  return found.name;
}

router.put(
  "/user/:id",
  upload.single("avatar"),
  detectSpam,
  verifyCaptcha,
  async (req, res) => {
    // Pastikan user sudah login dan ID cocok (kalau perlu validasi session/cookie di sini)

    // Ambil semua field dari body, dukung nama field dengan dan tanpa `_id`
    const username = req.body.username;
    const password = req.body.password;
    const nama_penerima = req.body.nama_penerima;
    const no_telepon = req.body.no_telepon;
    const alamat_lengkap = req.body.alamat_lengkap;
    const kode_pos = req.body.kode_pos;

    const provinsi_id = req.body.provinsi_id || req.body.provinsi;
    const kota_id = req.body.kota_id || req.body.kota;
    const kecamatan_id = req.body.kecamatan_id || req.body.kecamatan;
    const kelurahan_id = req.body.kelurahan_id || req.body.kelurahan;

    const updatePayload = {};

    try {
      // Username
      if (username) updatePayload.username = username;

      // Password (hash)
      if (password) updatePayload.password = await bcrypt.hash(password, 10);

      // Provinsi
      if (provinsi_id) {
        const provinsi_name = await getWilayahName(
          "https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json",
          provinsi_id,
        );
        updatePayload.provinsi = provinsi_name;
      }

      // Kota/Kabupaten
      if (kota_id && provinsi_id) {
        const kota_name = await getWilayahName(
          `https://www.emsifa.com/api-wilayah-indonesia/api/regencies/${provinsi_id}.json`,
          kota_id,
        );
        updatePayload.kota_kabupaten = kota_name;
      }

      // Kecamatan
      if (kecamatan_id && kota_id) {
        const kecamatan_name = await getWilayahName(
          `https://www.emsifa.com/api-wilayah-indonesia/api/districts/${kota_id}.json`,
          kecamatan_id,
        );
        updatePayload.kecamatan = kecamatan_name;
      }

      // Kelurahan
      if (kelurahan_id && kecamatan_id) {
        const kelurahan_name = await getWilayahName(
          `https://www.emsifa.com/api-wilayah-indonesia/api/villages/${kecamatan_id}.json`,
          kelurahan_id,
        );
        updatePayload.kelurahan = kelurahan_name;
      }

      // Data lain
      if (kode_pos) updatePayload.kode_pos = kode_pos;
      if (nama_penerima) updatePayload.nama_penerima = nama_penerima;
      if (no_telepon) updatePayload.no_telepon = no_telepon;
      if (alamat_lengkap) updatePayload.alamat_lengkap = alamat_lengkap;

      // Avatar update
      if (req.file) {
        const fileExt = path.extname(req.file.originalname);
        const fileName = `avatar_${Date.now()}${fileExt}`;
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from("avatars")
          .upload(fileName, req.file.buffer, {
            contentType: req.file.mimetype,
            upsert: true,
          });

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage
          .from("avatars")
          .getPublicUrl(fileName);

        updatePayload.avatar = publicUrlData.publicUrl;
      }

      // Simpan ke database
      const { data, error } = await supabase
        .from("users")
        .update(updatePayload)
        .eq("id", req.params.id)
        .select(
          "id, email, username, avatar, provinsi, kota_kabupaten, kecamatan, kelurahan, kode_pos, nama_penerima, no_telepon, alamat_lengkap",
        );

      if (error) throw error;

      res.json({ message: "✅ User berhasil diupdate.", user: data[0] });
    } catch (err) {
      console.error("Update user error:", err);
      res
        .status(500)
        .json({ error: "Gagal update user.", detail: err.message });
    }
  },
);

// ======================== DELETE USER ========================
router.delete("/user/:id", async (req, res) => {
  const cookie = req.cookies.user_info;
  if (!cookie) return res.status(401).json({ error: "Tidak ada sesi login." });

  let userInfo;
  try {
    userInfo = JSON.parse(cookie);
  } catch (e) {
    return res.status(400).json({ error: "Cookie tidak valid." });
  }

  if (userInfo.id !== req.params.id) {
    return res.status(403).json({ error: "Tidak boleh hapus user lain." });
  }

  try {
    const { error } = await supabase
      .from("users")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;

    res.clearCookie("user_info"); // Hapus cookie juga
    res.json({ message: "User berhasil dihapus dan sesi diakhiri." });
  } catch (err) {
    console.error("Delete user error:", err);
    res.status(500).json({ error: "Gagal menghapus user." });
  }
});

router.post("/login/google", detectSpam, verifyCaptcha, async (req, res) => {
  const { provider_token } = req.body;
  if (!provider_token) {
    return res.status(400).json({ error: "Token Google tidak ditemukan." });
  }

  try {
    // 1. Verifikasi token Google ke Supabase
    const { data: session, error: signInError } =
      await supabase.auth.signInWithIdToken({
        provider: "google",
        token: provider_token,
      });

    if (signInError || !session?.user) {
      console.error("Google sign-in error:", signInError);
      return res.status(401).json({ error: "Login Google gagal." });
    }

    const { email, user_metadata } = session.user;
    const googleAvatar = user_metadata?.avatar_url || null;

    // 2. Cek apakah user sudah ada di tabel users
    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    // 3. User belum ada → buat baru + OTP
    if (!user) {
      const username = email.split("@")[0];
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: insertErr } = await supabase.from("users").insert([
        {
          email,
          username,
          password: null, // tidak perlu password
          otp_code: otp,
          otp_expires_at: expiresAt,
          verified: false,
          avatar: googleAvatar, // langsung simpan avatar dari Google
        },
      ]);

      if (insertErr) {
        console.error("Insert user error:", insertErr);
        return res.status(500).json({ error: "Gagal menyimpan user." });
      }

      await generateOtp(email, otp);
      return res.status(201).json({
        success: true,
        step: "verify_otp",
        message: "User baru dibuat. OTP dikirim ke email.",
        email,
        avatar: googleAvatar,
      });
    }

    // 4. User belum diverifikasi → kirim OTP ulang
    if (!user.verified) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: updateErr } = await supabase
        .from("users")
        .update({ otp_code: otp, otp_expires_at: expiresAt })
        .eq("email", email);

      if (updateErr) {
        console.error("Update OTP error:", updateErr);
        return res.status(500).json({ error: "Gagal memperbarui OTP." });
      }

      await generateOtp(email, otp);
      return res.json({
        success: true,
        step: "verify_otp",
        message: "OTP dikirim ulang. Silakan verifikasi.",
        email,
        avatar: user.avatar || googleAvatar,
      });
    }

    // 5. User sudah verified → buat JWT + cookie
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    const isProd = process.env.NODE_ENV === "production";
    res.cookie(
      "user_info",
      JSON.stringify({
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar || googleAvatar,
      }),
      {
        httpOnly: true,
        secure: false, // ❌ ubah ke false di development
        sameSite: "Lax", // ✅ Lax cukup untuk localhost
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    );

    return res.json({
      message: "Login Google sukses.",
      token,
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar || googleAvatar,
    });
  } catch (err) {
    console.error("Google login error:", err);
    return res.status(500).json({ error: "Kesalahan server." });
  }
});

module.exports = router;
