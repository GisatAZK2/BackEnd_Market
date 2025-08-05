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

const router = express.Router();
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ======================== REGISTER ========================
router.post("/register", upload.single("avatar"), async (req, res) => {
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
      return res
        .status(400)
        .json({ error: "Email sudah digunakan. Silakan gunakan email lain." });
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
      return res.status(500).json({ error: "Gagal membuat user di database." });
    }

    await generateOtp(email, otp);
    res.status(201).json({ message: "User dibuat. OTP dikirim ke email." });
  } catch (err) {
    console.error("Error saat register:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
});

// ======================== VERIFIKASI OTP ========================
router.get("/flash-sale-customer/list", async (req, res) => {
  try {
    const tz =
      req.query.timezone || req.headers["x-timezone"] || "Asia/Jakarta";

    // Pakai gaya sama dengan /verify-otp (base dari Date())
    const now = new Date();
    const isoNow = now.toISOString();

    // Tentukan rentang hari (berdasarkan timezone device)
    const startOfDay = new Date(now.setHours(0, 0, 0, 0)).toISOString();
    const endOfDay = new Date(now.setHours(23, 59, 59, 999)).toISOString();

    console.log("[TIMEZONE DEVICE]", tz);
    console.log("[NOW ISO]", isoNow);
    console.log("[RANGE QUERY UTC]", startOfDay, " -> ", endOfDay);

    // Ambil semua flash sale yang overlap dengan hari ini
    const { data: flashSales, error } = await supabase
      .from("flash_sales")
      .select("*")
      .lte("start_time", endOfDay) // mulai sebelum hari ini berakhir
      .gte("end_time", startOfDay) // berakhir setelah hari ini mulai
      .order("start_time", { ascending: true });

    if (error) {
      console.error("[DB ERROR]", error);
      return res
        .status(500)
        .json({ message: "❌ Gagal mengambil daftar flash sale", error });
    }

    if (!flashSales || flashSales.length === 0) {
      console.warn("[NO FLASH SALE FOUND]");
      return res.status(404).json({
        message: "❌ Flash sale tidak ditemukan untuk hari ini",
        date: isoNow.split("T")[0],
      });
    }

    // Ambil produk yang ikut flash sale
    const { data: flashSaleProducts, error: fspErr } = await supabase
      .from("flash_sale_products")
      .select(`*, products (*), sellers (*), product_variants (*)`)
      .in(
        "flash_sale_id",
        flashSales.map((fs) => fs.id),
      );

    if (fspErr) {
      console.error("[FLASH SALE PRODUCTS ERROR]", fspErr);
      return res
        .status(500)
        .json({
          message: "❌ Gagal mengambil produk flash sale",
          error: fspErr,
        });
    }

    // Group produk per flash sale
    const flashSaleProductsMap = {};
    for (const fsp of flashSaleProducts) {
      if (!flashSaleProductsMap[fsp.flash_sale_id]) {
        flashSaleProductsMap[fsp.flash_sale_id] = [];
      }
      if (fsp.products) {
        flashSaleProductsMap[fsp.flash_sale_id].push(fsp.products);
      }
    }

    // Bagi ke sesi
    const sessions = {
      morning: { label: "00:00 - 12:00", flash_sales: [] },
      afternoon: { label: "12:00 - 18:00", flash_sales: [] },
      evening: { label: "18:00 - 00:00", flash_sales: [] },
    };

    for (const fs of flashSales) {
      const start = new Date(fs.start_time);
      const end = new Date(fs.end_time);

      // Tentukan status display
      let status = fs.status;
      if (fs.status === "active") {
        if (new Date(isoNow) < start) status = "upcoming";
        else if (new Date(isoNow) >= start && new Date(isoNow) <= end)
          status = "ongoing";
        else status = "ended";
      } else if (fs.status === "disabled") {
        status = "disabled";
      }

      const products = flashSaleProductsMap[fs.id] || [];
      const productsWithDiscount =
        products.length > 0
          ? await attachVariantsStockDiscountWithRealDiscount(products)
          : [];

      const flashSaleWithProducts = {
        ...fs,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        display_status: status,
        products: productsWithDiscount,
      };

      // Tentukan sesi berdasarkan jam mulai
      const startHour = start.getHours();
      if (startHour >= 0 && startHour < 12)
        sessions.morning.flash_sales.push(flashSaleWithProducts);
      else if (startHour >= 12 && startHour < 18)
        sessions.afternoon.flash_sales.push(flashSaleWithProducts);
      else if (startHour >= 18 && startHour <= 23)
        sessions.evening.flash_sales.push(flashSaleWithProducts);
    }

    // Sesi aktif sekarang
    const currentHour = new Date(isoNow).getHours();
    let currentSession = null;
    if (currentHour >= 0 && currentHour < 12) currentSession = "morning";
    else if (currentHour >= 12 && currentHour < 18)
      currentSession = "afternoon";
    else if (currentHour >= 18 && currentHour <= 23) currentSession = "evening";

    return res.json({
      message: `✅ Flash sale untuk ${isoNow.split("T")[0]} ditemukan`,
      date: isoNow.split("T")[0],
      timezone: tz,
      current_session: currentSession,
      sessions,
    });
  } catch (err) {
    console.error("[SERVER ERROR]", err);
    return res
      .status(500)
      .json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// ======================== LOGIN ========================
router.post("/login", async (req, res) => {
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
router.post("/forgot-password", async (req, res) => {
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
router.post("/reset-password", async (req, res) => {
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

  // Pastikan cookie user_info.id sama dengan param id
  if (userInfo.id !== req.params.id) {
    return res.status(403).json({ error: "Sesi login tidak valid." });
  }

  // === Tambahin avatar di select ===
  const { data: user, error } = await supabase
    .from("users")
    .select("id, email, username, verified, avatar")
    .eq("id", req.params.id)
    .single();

  if (error || !user)
    return res.status(404).json({ error: "User tidak ditemukan." });

  res.json({ user });
});

// ======================== UPDATE USER ========================
// ======================== UPDATE USER ========================
router.put("/user/:id", upload.single("avatar"), async (req, res) => {
  const cookie = req.cookies.user_info;
  if (!cookie) return res.status(401).json({ error: "Tidak ada sesi login." });

  let userInfo;
  try {
    userInfo = JSON.parse(cookie);
  } catch (e) {
    return res.status(400).json({ error: "Cookie tidak valid." });
  }

  if (userInfo.id !== req.params.id) {
    return res
      .status(403)
      .json({ error: "Tidak boleh update data user lain." });
  }

  const { username, password } = req.body;

  try {
    // Ambil user lama
    const { data: oldUser, error: oldUserErr } = await supabase
      .from("users")
      .select("avatar")
      .eq("id", req.params.id)
      .single();
    if (oldUserErr || !oldUser) {
      return res.status(404).json({ error: "User tidak ditemukan." });
    }

    const updatePayload = {};

    // === Update username & password ===
    if (username) updatePayload.username = username;
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      updatePayload.password = hashed;
    }

    // === Update avatar jika ada file baru ===
    if (req.file) {
      const filename = `avatar_${Date.now()}.webp`;

      // Hapus avatar lama kalau ada dan bukan default
      if (oldUser.avatar && !oldUser.avatar.includes("avatar_default")) {
        const oldPath = oldUser.avatar.split("/").pop(); // ambil nama file saja
        await supabase.storage.from("avatars").remove([oldPath]);
      }

      const buffer = await sharp(req.file.buffer)
        .webp({ quality: 80 })
        .toBuffer();

      const { error: uploadErr } = await supabase.storage
        .from("avatars")
        .upload(filename, buffer, {
          contentType: "image/webp",
          upsert: true,
        });

      if (uploadErr) {
        console.error("Upload avatar error:", uploadErr);
        return res.status(500).json({ error: "Gagal upload avatar baru." });
      }

      const { data: publicUrl } = supabase.storage
        .from("avatars")
        .getPublicUrl(filename);

      updatePayload.avatar = publicUrl.publicUrl;
    }

    // Update ke database
    const { data, error } = await supabase
      .from("users")
      .update(updatePayload)
      .eq("id", req.params.id)
      .select("id, email, username, avatar");

    if (error) throw error;

    res.json({ message: "User berhasil diupdate.", user: data[0] });
  } catch (err) {
    console.error("Update user error:", err);
    res.status(500).json({ error: "Gagal update user." });
  }
});

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

router.post("/login/google", async (req, res) => {
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
    rres.cookie(
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
