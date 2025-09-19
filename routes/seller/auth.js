const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const supabase = require("../../config/supabase");
const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const detectSpam = require("../../middleware/detectSpam");
const verifyCaptcha = require("../../middleware/verifyCaptcha");
const fetch = require("node-fetch");

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });


const SEND_URL = process.env.SEND_SERVICE_URL;


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
        const defaultImagePath = path.join(__dirname, "../assets/user.png");
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

        // 🚀 Kirim OTP lewat SMTP microservice
        await axios.post(`${SEND_URL}/send-email`, {
          type: "otp",
          email,
          code: otp,
        });

        res.status(201).json({ message: "User dibuat. OTP dikirim ke email." });

    } catch (err) {
      console.error("Error saat register:", err);
      res.status(500).json({ error: "Terjadi kesalahan pada server." });
    }
  },
);

router.post("/verify-otp", async (req, res) => {
  try {
    let { email, otp, mode = "email", googleId } = req.body;

    // Jika email berupa object (nested), ekstrak fieldnya
    if (typeof email === "object" && email !== null) {
      const nested = email;
      email = nested.email || email;
      otp = nested.otp || otp;
      mode = nested.mode || mode;
      googleId = nested.googleId || googleId;
    }

    if (mode === "google" && !googleId) {
      console.log("GoogleId kosong, fallback ke email+otp");
      mode = "email";
    }

    if (mode === "email") {
      if (!email || !otp) {
        return res.status(400).json({
          success: false,
          message: "Email dan OTP diperlukan.",
        });
      }
    }

    // === Query user ===
    let userQuery = supabase.from("users").select("*");
    if (mode === "google") {
      userQuery = userQuery.eq("google_id", googleId);
    } else {
      userQuery = userQuery.eq("email", email);
    }

    const { data: user, error: userErr } = await userQuery.maybeSingle();
    if (userErr) {
      return res
        .status(500)
        .json({ success: false, message: "Gagal memeriksa pengguna." });
    }
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User tidak ditemukan." });
    }

    // === Validasi OTP (hanya email mode) ===
    if (mode !== "google") {
      const now = new Date().toISOString();
      if (user.otp_code !== otp || user.otp_expires_at <= now) {
        return res
          .status(400)
          .json({ success: false, message: "OTP salah atau kadaluarsa." });
      }
    }

    // === Update verified ===
    await supabase
      .from("users")
      .update({
        verified: true,
        otp_code: null,
        otp_expires_at: null,
      })
      .eq(mode === "google" ? "google_id" : "email", mode === "google" ? googleId : email);

    // === Generate JWT untuk Google Mode ===
    let token = null;
    if (mode === "google") {
      token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });
    }

    // === Cek seller berdasarkan email ===
    const { data: seller, error: sellerErr } = await supabase
      .from("sellers")
      .select("*")
      .eq("email", user.email)
      .maybeSingle();

    if (sellerErr) {
      return res
        .status(500)
        .json({ success: false, message: "Gagal memeriksa status seller." });
    }

    // === Jika belum jadi seller ===
    if (!seller) {
      return res.json({
        success: true,
        step: "register_seller",
        message: "Akun diaktifkan. Harap daftar sebagai seller.",
        token,
        id: user.id,
      });
    }

    // === Kalau seller ada ===
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
      }
    );

    return res.json({
      success: true,
      step: mode === "google" ? "redirect_dashboard" : "login_manual",
      message:
        mode === "google"
          ? "Akun diaktifkan & login otomatis."
          : "OTP valid. Akun diaktifkan. Silakan login manual.",
      token,
      id: user.id,
      seller_id: seller.id, // <<<<<< ini dikembalikan biar FE bisa simpan
    });
  } catch (err) {
    console.error("OTP Error:", err.message);
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

    // Token tetap berdasarkan user.id
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    if (!seller) {
      // Kalau seller belum terdaftar → pakai user_info sementara
      res.cookie(
        "user_info",
        JSON.stringify({
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar || null,
        }),
        {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "None",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        }
      );

      return res.status(409).json({
        message: "User ini belum terdaftar sebagai seller",
        token,
        user_info: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar || null,
        },
      });
    }

    // Kalau seller sudah ada → pakai seller_info
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


// GET Seller profile + total followers + account bank
router.get("/profile/:id", async (req, res) => {
  try {
    let sellerId;

    if (req.params.id) {
      sellerId = req.params.id;
    } else {
      const sellerCookie = req.cookies?.seller_info;
      if (!sellerCookie) {
        return res.status(401).json({ error: "Seller belum login." });
      }
      try {
        const sellerInfo = JSON.parse(sellerCookie);
        sellerId = sellerInfo.id;
      } catch {
        return res.status(400).json({ error: "Cookie seller tidak valid." });
      }
    }

    // Ambil data seller
    const { data: seller, error: sellerError } = await supabase
      .from("sellers")
      .select("*")
      .eq("id", sellerId)
      .single();

    if (sellerError || !seller) {
      return res.status(404).json({ error: "Seller tidak ditemukan." });
    }

    // Ambil data rekening dari seller_balances
    const { data: balance, error: balanceError } = await supabase
      .from("seller_balances")
      .select("bank_code, account_number, account_holder_name, seller_pin_hash")
      .eq("seller_id", sellerId)
      .single();

    if (balanceError) {
      return res.status(500).json({
        error: "Gagal mengambil data rekening seller.",
        detail: balanceError.message,
      });
    }

    // Gabungkan alamat
    const alamat_lengkap_combine = [
      seller.store_address || seller.alamat_lengkap || "",
      seller.kelurahan || "",
      seller.kecamatan || "",
      seller.kabupaten || seller.kota_kabupaten || "",
    ]
      .filter(Boolean)
      .join(", ");

    // Hitung jumlah followers
    const { count: totalFollowers, error: followerError } = await supabase
      .from("follows")
      .select("*", { count: "exact", head: true })
      .eq("seller_id", sellerId);

    if (followerError) {
      return res.status(500).json({
        error: "Gagal mengambil jumlah followers.",
        detail: followerError.message,
      });
    }

    // Ambil daftar followers
    const { data: followers, error: followersError } = await supabase
      .from("follows")
      .select(`
        user_id,
        users (id, username, email, avatar, created_at)
      `)
      .eq("seller_id", sellerId);

    if (followersError) {
      return res.status(500).json({
        error: "Gagal mengambil daftar followers.",
        detail: followersError.message,
      });
    }

    res.json({
      seller: {
        ...seller,
        alamat_lengkap_combine,
        total_followers: totalFollowers || 0,
        followers: followers?.map((f) => f.users) || [],
        bank_info: balance || null, // kalau belum ada record, null
      },
    });
  } catch (err) {
    console.error("Get seller profile error:", err);
    res.status(500).json({ error: "Terjadi kesalahan server." });
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
      `https://sellercihuy.sytes.net/forgot-password?email=${encodeURIComponent(email)}`;

    // 🚀 Kirim email reset lewat SMTP microservice
await axios.post(`${SEND_URL}/send-email`, {
  type: "reset",
  email,
  resetLink: link,
});

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


//Multer setup for store image
const uploadStoreImage = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "image/jpeg" || file.mimetype === "image/png") {
      cb(null, true);
    } else {
      cb(new Error("Gambar toko harus JPEG atau PNG"));
    }
  },
});

// ====================== UPDATE USER ======================
// Helper ambil nama wilayah (sama persis seperti di user)
async function getWilayahName(url, id) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Gagal fetch data wilayah");
  const list = await res.json();
  const found = list.find((item) => item.id == id);
  if (!found) throw new Error(`Wilayah dengan id ${id} tidak ditemukan`);
  return found.name;
}


// PUT /seller/update/:id (Update Seller)
router.put(
  "/seller/update/:id",
  uploadStoreImage.single("store_image_url"),
  async (req, res) => {
    try {
      console.log("👉 Mulai proses update seller");

      const sellerInfo = req.cookies?.seller_info
        ? JSON.parse(req.cookies.seller_info)
        : null;

      if (!sellerInfo?.id) {
        console.log("❌ Seller belum login");
        return res
          .status(401)
          .json({ error: "❌ Harus login sebagai seller" });
      }

      const sellerId = req.params.id;
      console.log("🔑 Seller ID dari param:", sellerId);
      console.log("🔑 Seller ID dari cookie:", sellerInfo.id);

      if (sellerId !== sellerInfo.id) {
        console.log("⚠️ Seller mencoba update data seller lain");
        return res.status(403).json({
          error: "❌ Tidak diizinkan mengubah data seller lain",
        });
      }

      const body = req.body || {};
      console.log("📦 Body request:", body);

      const {
        email,
        name,
        business_name,
        phone,
        store_name,
        store_address,
        provinsi_id,
        kabupaten_id,
        kecamatan_id,
        kelurahan_id,
        latitude,
        longitude,
        role,
        is_delivery_available,
        delivery_fee,
        pin,
        bankCode,
        accountHolderName,
        accountNumber,
      } = body;

      // Validate PIN if provided
      if (pin && (pin.toString().length < 4 || pin.toString().length > 6)) {
        return res.status(400).json({ error: "⚠️ PIN harus 4-6 digit." });
      }

      // Validate bank fields if any are provided
      if (
        (bankCode || accountHolderName || accountNumber) &&
        !(bankCode && accountHolderName && accountNumber)
      ) {
        return res.status(400).json({
          error:
            "⚠️ bankCode, accountHolderName, dan accountNumber harus diisi bersama-sama jika salah satu disediakan.",
        });
      }

      const updateSellerPayload = {};
      const updateBalancePayload = {};

      // Populate seller payload
      if (email) updateSellerPayload.email = email;
      if (name) updateSellerPayload.name = name;
      if (business_name) updateSellerPayload.business_name = business_name;
      if (phone) updateSellerPayload.phone = phone;
      if (store_name) updateSellerPayload.store_name = store_name;
      if (store_address) updateSellerPayload.store_address = store_address;
      if (latitude) updateSellerPayload.latitude = parseFloat(latitude);
      if (longitude) updateSellerPayload.longitude = parseFloat(longitude);
      if (role) updateSellerPayload.role = role;
      if (typeof is_delivery_available !== "undefined")
        updateSellerPayload.is_delivery_available =
          String(is_delivery_available).toLowerCase() === "true";
      if (delivery_fee) updateSellerPayload.delivery_fee = parseFloat(delivery_fee);

      // === Upload / Replace Gambar Toko ===
      if (req.file) {
        console.log("🖼️ File upload diterima:", req.file.originalname);
        const filename = `store_${sellerId}_${Date.now()}.webp`;

        const buffer = await sharp(req.file.buffer)
          .webp({ quality: 80 })
          .toBuffer();

        const { error: uploadError } = await supabase.storage
          .from("store-photos")
          .upload(filename, buffer, {
            contentType: "image/webp",
            upsert: true,
          });

        if (uploadError) {
          console.error("❌ Gagal upload gambar:", uploadError);
          return res.status(400).json({
            error: "Upload gagal",
            detail: uploadError.message,
          });
        }

        const { data: publicUrl } = supabase.storage
          .from("store-photos")
          .getPublicUrl(filename);

        updateSellerPayload.store_image_url = publicUrl.publicUrl;
      }

      // === Update wilayah ===
      if (provinsi_id) {
        updateSellerPayload.provinsi = await getWilayahName(
          "https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json",
          provinsi_id
        );
      }
      if (kabupaten_id && provinsi_id) {
        updateSellerPayload.kabupaten = await getWilayahName(
          `https://www.emsifa.com/api-wilayah-indonesia/api/regencies/${provinsi_id}.json`,
          kabupaten_id
        );
      }
      if (kecamatan_id && kabupaten_id) {
        updateSellerPayload.kecamatan = await getWilayahName(
          `https://www.emsifa.com/api-wilayah-indonesia/api/districts/${kabupaten_id}.json`,
          kecamatan_id
        );
      }
      if (kelurahan_id && kecamatan_id) {
        updateSellerPayload.kelurahan = await getWilayahName(
          `https://www.emsifa.com/api-wilayah-indonesia/api/villages/${kecamatan_id}.json`,
          kelurahan_id
        );
      }

      // Validate wilayah dependencies
      if (
        (kelurahan_id && !kecamatan_id) ||
        (kecamatan_id && !kabupaten_id) ||
        (kabupaten_id && !provinsi_id)
      ) {
        return res.status(400).json({
          error: "Data wilayah tidak lengkap. Harus menyertakan provinsi, kabupaten, kecamatan, dan kelurahan secara berurutan.",
        });
      }

      // === Populate balance payload ===
      if (pin) {
        updateBalancePayload.seller_pin_hash = await bcrypt.hash(pin.toString(), 12);
      }
      if (bankCode) updateBalancePayload.bank_code = bankCode;
      if (accountHolderName) updateBalancePayload.account_holder_name = accountHolderName;
      if (accountNumber) updateBalancePayload.account_number = accountNumber;

      console.log("📤 Payload final untuk sellers:", updateSellerPayload);
      console.log("📤 Payload final untuk seller_balances:", updateBalancePayload);

      // === Update DB seller ===
      if (Object.keys(updateSellerPayload).length > 0) {
        const { data: sellerData, error: sellerError } = await supabase
          .from("sellers")
          .update(updateSellerPayload)
          .eq("id", sellerId)
          .select();

        if (sellerError) {
          console.error("❌ Gagal update seller di DB:", sellerError);
          return res.status(400).json({ error: sellerError.message });
        }

        console.log("✅ Data seller berhasil diperbarui:", sellerData);
      }

      // === Update DB seller_balances ===
      if (Object.keys(updateBalancePayload).length > 0) {
        const { data: balanceData, error: balanceError } = await supabase
          .from("seller_balances")
          .update(updateBalancePayload)
          .eq("seller_id", sellerId)
          .select();

        if (balanceError) {
          console.error("❌ Gagal update seller_balances di DB:", balanceError);
          return res.status(400).json({ error: balanceError.message });
        }

        console.log("✅ Data seller_balances berhasil diperbarui:", balanceData);
      }

      // === Sinkronisasi seller_name di tabel products ===
      if (name) {
        console.log("🔄 Update semua produk seller dengan seller_name baru:", name);
        const { error: productUpdateError } = await supabase
          .from("products")
          .update({ seller_name: name })
          .eq("seller_id", sellerId);

        if (productUpdateError) {
          console.error("⚠️ Gagal sinkronisasi seller_name di products:", productUpdateError);
          // Jangan return error, biarkan update seller tetap berhasil
        } else {
          console.log("✅ Semua produk berhasil diupdate seller_name.");
        }
      }

      res.json({
        message: "✅ Data toko berhasil diperbarui",
        data: {
          seller: updateSellerPayload,
          balance: updateBalancePayload,
        },
      });
    } catch (err) {
      console.error("💥 Error server:", err);
      res.status(500).json({
        error: "Terjadi kesalahan server",
        detail: err.message,
      });
    }
  }
);


// ======================== DELETE USER ========================
router.post("/login/google", async (req, res) => {
  const { id_token } = req.body;
  if (!id_token) return res.status(400).json({ error: "ID token Google tidak ditemukan." });

  try {
    // 1. Verifikasi token Google
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;
    const googleAvatar = payload.picture || null;

    // 2. Cek user
    let { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    // 3. User baru → buat user + OTP
    if (!user) {
      const username = email.split("@")[0];
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: insertErr, data: newUser } = await supabase.from("users").insert([{
        email,
        username,
        password: null,
        otp_code: otp,
        otp_expires_at: expiresAt,
        verified: false,
        avatar: googleAvatar,
      }]).select().single();

      if (insertErr) {
        console.error(insertErr);
        return res.status(500).json({ error: "Gagal menyimpan user." });
      }
            // 🚀 Kirim OTP lewat SMTP microservice
      await axios.post(`${SEND_URL}/send-email`, {
        type: "otp",
        email,
        code: otp,
      });

      return res.status(201).json({
        success: true,
        step: "verify_otp",
        message: "User baru dibuat. OTP dikirim ke email.",
        email,
        avatar: googleAvatar,
      });

    }

    // 4. User ada tapi belum verified → OTP ulang
    if (!user.verified) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: updateErr } = await supabase
        .from("users")
        .update({ otp_code: otp, otp_expires_at: expiresAt })
        .eq("email", email);

      if (updateErr) return res.status(500).json({ error: "Gagal memperbarui OTP." });
// 🚀 Kirim ulang OTP lewat SMTP microservice
await axios.post(`${SEND_URL}/send-email`, {
  type: "otp",
  email,
  code: otp,
});

return res.json({
  success: true,
  step: "verify_otp",
  message: "OTP dikirim ulang. Silakan verifikasi.",
  email,
  avatar: user.avatar || googleAvatar,
});

    }

    // 5. User verified → cek seller
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    let { data: seller } = await supabase
      .from("sellers")
      .select("*")
      .eq("email", email)
      .single();

    // Kalau belum seller → balikin info user
    if (!seller) {
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
          secure: process.env.NODE_ENV === "production",
          sameSite: "None",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        }
      );

      return res.status(409).json({
        message: "User ini belum terdaftar sebagai seller",
        token,
        user_info: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar || googleAvatar,
        },
      });
    }

    // Kalau seller ada → set cookie seller_info
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
      }
    );

    return res.json({
      message: "Login Google seller sukses.",
      token,
      seller_id: seller.id,
      store_name: seller.store_name,
      profile_seller: seller.store_image_url,
      email: seller.email,
    });
  } catch (err) {
    console.error("Google login seller error:", err);
    return res.status(500).json({ error: "Kesalahan server." });
  }
});


router.delete("/seller/:id", async (req, res) => {
  const cookie = req.cookies.seller_info;
  if (!cookie) {
    return res.status(401).json({ error: "❌ Tidak ada sesi login seller." });
  }

  let sellerInfo;
  try {
    sellerInfo = JSON.parse(cookie);
  } catch (err) {
    return res.status(400).json({ error: "❌ Cookie seller tidak valid." });
  }

  if (sellerInfo.id !== req.params.id) {
    return res.status(403).json({ error: "❌ Tidak boleh menghapus seller lain." });
  }

  const sellerId = req.params.id;
  const mode = req.query.mode || "account-only"; // default akun saja

  try {
    // Ambil semua order & produk seller
    const { data: orders } = await supabase
      .from("orders")
      .select("id")
      .eq("seller_id", sellerId);
    const orderIds = orders?.map(o => o.id) || [];

    const { data: products } = await supabase
      .from("products")
      .select("id")
      .eq("seller_id", sellerId);
    const productIds = products?.map(p => p.id) || [];

    // Ambil semua store_discount, flash_sale_products, event_products
    const { data: storeDiscounts } = await supabase
      .from("store_discounts")
      .select("id")
      .eq("store_id", sellerId);
    const storeDiscountIds = storeDiscounts?.map(s => s.id) || [];

    const { data: flashSaleProducts } = await supabase
      .from("flash_sale_products")
      .select("flash_sale_id")
      .eq("seller_id", sellerId);
    const flashSaleIds = [...new Set(flashSaleProducts?.map(f => f.flash_sale_id) || [])];

    const { data: eventProducts } = await supabase
      .from("event_products")
      .select("event_id")
      .eq("seller_id", sellerId);
    const eventIds = [...new Set(eventProducts?.map(e => e.event_id) || [])];

    // Mode: hapus akun + order
    if (mode === "orders" || mode === "all" || mode === "full") {
      if (orderIds.length > 0) {
        await supabase.from("order_items").delete().in("order_id", orderIds);
        await supabase.from("orders").delete().eq("seller_id", sellerId);
      }
    }

    // Mode: hapus akun + produk
    if (mode === "products" || mode === "all" || mode === "full") {
      if (productIds.length > 0) {
        await supabase.from("product_variants").delete().in("product_id", productIds);
        await supabase.from("products").delete().eq("seller_id", sellerId);
      }
    }

    // Mode: hapus akun + store discounts
    if (mode === "full") {
      if (storeDiscountIds.length > 0) {
        await supabase.from("store_discount_items").delete().in("discount_id", storeDiscountIds);
        await supabase.from("store_discounts").delete().eq("store_id", sellerId);
      }

      if (flashSaleIds.length > 0) {
        await supabase.from("flash_sale_products").delete().eq("seller_id", sellerId);
        // NOTE: kalau mau hapus master flash_sale, pastikan dia milik seller ini
        await supabase.from("flash_sales").delete().in("id", flashSaleIds);
      }

      if (eventIds.length > 0) {
        await supabase.from("event_products").delete().eq("seller_id", sellerId);
        await supabase.from("events").delete().in("id", eventIds);
      }
    }

    // Mode: hanya hapus akun
    if (mode === "account-only") {
      if (orderIds.length > 0) {
        await supabase
          .from("orders")
          .update({ seller_id: null })
          .eq("seller_id", sellerId);
      }
      if (productIds.length > 0) {
        await supabase
          .from("products")
          .update({ seller_id: null })
          .eq("seller_id", sellerId);
      }
    }

    // Hapus akun seller
    await supabase.from("sellers").delete().eq("id", sellerId);

    res.clearCookie("seller_info");
    res.json({ message: `✅ Seller berhasil dihapus dengan mode: ${mode}` });

  } catch (err) {
    console.error("Delete seller error:", err);
    res.status(500).json({ error: "❌ Terjadi kesalahan saat menghapus seller." });
  }
});



module.exports = router;
