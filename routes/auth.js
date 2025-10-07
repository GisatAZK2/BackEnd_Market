const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const supabase = require("../config/supabase");
const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const axios = require("axios");
const detectSpam = require("../middleware/detectSpam");
const verifyCaptcha = require("../middleware/verifyCaptcha");
const fetch = require("node-fetch");


const SEND_URL = process.env.SEND_SERVICE_URL;


const router = express.Router();
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    // Semua jenis gambar populer
const validTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/svg+xml",
  "image/heif",
  "image/heic"
];

    if (validTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Hanya file JPEG atau PNG yang diizinkan."));
    }
  },
});




// ======================== REGISTER ========================
router.post("/register", upload.single("avatar"), async (req, res) => {
  const { email, password, username, pin } = req.body;
  console.log("Body register:", req.body);

  try {
    // === Cek user sudah ada atau belum ===
    const { data: existingUser, error: findErr } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (findErr) {
      console.error("Supabase error:", findErr);
      return res.status(500).json({ error: "Gagal cek email user." });
    }
    if (existingUser) {
      return res.status(400).json({ error: "Email sudah digunakan." });
    }

    // === Buat username final ===
    const finalUsername =
      username && username.trim() !== ""
        ? username.trim()
        : email.split("@")[0];

    // Hash password
    const hashed = await bcrypt.hash(password, 10);

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    // === Avatar Handling ===
    let avatarPath;
    if (req.file) {
      const filename = `avatar_${Date.now()}.webp`;
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
        console.error("Upload error:", uploadErr);
        return res.status(500).json({ error: "Gagal upload avatar." });
      }

      const { data: publicUrl } = supabase.storage
        .from("avatars")
        .getPublicUrl(filename);
      avatarPath = publicUrl.publicUrl;
    } else {
      avatarPath = process.env.DEFAULT_AVATAR_URL;
    }

    // === Simpan user ke database ===
    const { data: newUser, error: insertErr } = await supabase
      .from("users")
      .insert([
        {
          email,
          username: finalUsername,
          password: hashed,
          otp_code: otp,
          otp_expires_at: expiresAt,
          verified: false,
          avatar: avatarPath,
        },
      ])
      .select("id, email")
      .single();

    if (insertErr) {
      console.error("Supabase insert error:", insertErr);
      return res.status(500).json({ error: "Gagal membuat user." });
    }

    // === Kalau ada PIN di register ===
    if (pin) {
      const pinHash = await bcrypt.hash(pin.toString(), 12);
      await supabase.from("user_balances").insert([
        {
          user_id: newUser.id,
          user_pin_hash: pinHash,
          user_pin_plain: pin.toString(), // simpan plain juga
        },
      ]);
    } else {
      await supabase.from("user_balances").insert([{ user_id: newUser.id }]);
    }

    // === Kirim OTP via Email Service ===
    axios
      .post(`${SEND_URL}/send-email`, {
        type: "otp",
        email,
        code: otp,
      })
      .catch((err) => {
        console.error("❌ Gagal kirim OTP:", err.message);
      });

    res.status(201).json({ message: "User dibuat. OTP dikirim ke email." });
  } catch (err) {
    console.error("Error saat register:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
});
// ======================== VERIFIKASI OTP ========================
router.post("/verify-otp", async (req, res) => {
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
    // === Cari user ===
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (userError) {
      console.error("Supabase user error:", userError);
    }

    if (!user || !user.verified) {
      return res
        .status(403)
        .json({ error: "Akun tidak ditemukan atau belum diverifikasi." });
    }

    // === Validasi password ===
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Password salah." });

    // === Cek apakah user juga seller ===
    const { data: seller, error: sellerError } = await supabase
      .from("sellers")
      .select("id, email")
      .eq("email", email)
      .single();

    if (sellerError && sellerError.code !== "PGRST116") {
      // PGRST116 = no rows found → aman diabaikan
      console.error("Supabase seller error:", sellerError);
    }

    // === Buat JWT ===
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
        seller_id: seller ? seller.id : null, // kalau ada seller, simpan seller_id
      }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "None",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      }
    );

    // === Respon ke frontend ===
    res.json({
      message: "Login sukses.",
      token,
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar,
      seller_id: seller ? seller.id : null, // kirim juga biar frontend tau
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


// ======================== CEK PIN USER ========================
router.get("/user/:id/check-pin", async (req, res) => {
  try {
    const userId = req.params.id;
    const { data: balance, error } = await supabase
      .from("user_balances")
      .select("user_pin_hash")
      .eq("user_id", userId)
      .single();

    if (error) throw error;

    res.json({ hasPin: !!balance?.user_pin_hash });
  } catch (err) {
    console.error("Check PIN error:", err);
    res.status(500).json({ error: "Gagal cek PIN." });
  }
});

// ======================== CHANGE / SET PIN ========================
router.post("/user/change-pin/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const { old_pin, new_pin } = req.body;

    if (!new_pin) {
      return res.status(400).json({ error: "PIN baru diperlukan." });
    }
    if (new_pin.toString().length < 4 || new_pin.toString().length > 6) {
      return res.status(400).json({ error: "PIN harus 4-6 digit." });
    }

   /* try {
      const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
      email = userInfo?.email || null;
    } catch (err) {
      console.error("❌ Error parsing cookies user_info:", err.message);
    }*/

    // Ambil balance user
    const { data: balance, error: balanceError } = await supabase
      .from("user_balances")
      .select("user_pin_hash")
      .eq("user_id", userId)
      .single();

    if (balanceError || !balance) {
      return res.status(404).json({ error: "User balance tidak ditemukan." });
    }

    if (balance.user_pin_hash) {
      if (!old_pin) {
        return res.status(400).json({ error: "PIN lama diperlukan." });
      }
      const isMatch = await bcrypt.compare(old_pin.toString(), balance.user_pin_hash);
      if (!isMatch) {
        return res.status(400).json({ error: "PIN lama salah." });
      }
    }

    // Hash PIN baru
    const newPinHash = await bcrypt.hash(new_pin.toString(), 12);

    const { error: updateErr } = await supabase
      .from("user_balances")
      .update({
        user_pin_hash: newPinHash,
        user_pin_plain: new_pin.toString(), // simpan plain juga
      })
      .eq("user_id", userId);

    if (updateErr) {
      console.error("❌ Gagal update PIN:", updateErr.message);
      return res.status(500).json({ error: "Gagal update PIN." });
    }

    /**if (email) {
      try {
        await axios.post(`${SEND_URL}/send-email-user-sensitive`, { email });
      } catch (err) {
        console.error("❌ Gagal kirim email PIN change:", err.message);
      }
    }**/

    res.json({ message: "✅ PIN berhasil diubah." });
  } catch (err) {
    console.error("Change PIN error:", err);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// ======================== REQUEST PIN via EMAIL ========================
router.post("/user/request-pin/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    // Ambil user + balance
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("id, email")
      .eq("id", userId)
      .single();

    if (userErr || !user) {
      return res.status(404).json({ error: "User tidak ditemukan." });
    }

    const { data: balance, error: balanceError } = await supabase
      .from("user_balances")
      .select("user_pin_plain")
      .eq("user_id", userId)
      .single();

    if (balanceError || !balance?.user_pin_plain) {
      return res.status(404).json({ error: "PIN belum diset." });
    }

    try {
      await axios.post(`${SEND_URL}/send-email-user-pin`, {
        email: user.email,
        pin: balance.user_pin_plain,
      });
    } catch (err) {
      console.error("❌ Gagal kirim email PIN:", err.message);
      return res.status(500).json({ error: "Gagal kirim PIN ke email." });
    }

    res.json({ message: "✅ PIN telah dikirim ke email." });
  } catch (err) {
    console.error("Request PIN error:", err);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// === Route get user detail
router.get("/user/:id", async (req, res) => {
  const cookie = req.cookies.user_info;
  if (!cookie) return res.status(401).json({ error: "Tidak ada sesi login." });

  let userInfo;
  try {
    userInfo = JSON.parse(cookie);
  } catch{
    return res.status(400).json({ error: "Cookie tidak valid." });
  }

  if (userInfo.id !== req.params.id) {
    return res.status(403).json({ error: "Sesi login tidak valid." });
  }

  // === Ambil data user
  const { data: user, error } = await supabase
    .from("users")
    .select(
      `id, email, username, verified, avatar,
       provinsi, kota_kabupaten, kecamatan, kelurahan, kode_pos,
       nama_penerima, no_telepon, alamat_lengkap`
    )
    .eq("id", req.params.id)
    .single();

  if (error || !user) {
    return res.status(404).json({ error: "User tidak ditemukan." });
  }

  // === Gabungkan alamat
  const alamat_lengkap_combine = [
    user.alamat_lengkap,
    user.kelurahan,
    user.kecamatan,
    user.kota_kabupaten,
    user.kode_pos,
  ]
    .filter(Boolean)
    .join(", ");

  // === Hitung jumlah seller yang difollow user ini
  const { count: totalFollowing, error: followError } = await supabase
    .from("follows")
    .select("*", { count: "exact", head: true })
    .eq("user_id", req.params.id);

  if (followError) {
    return res.status(500).json({
      error: "Gagal mengambil data follow.",
      detail: followError.message,
    });
  }

  // === (Opsional) ambil list seller yang difollow
  const { data: followingSellers, error: sellersError } = await supabase
    .from("follows")
    .select(
      `seller_id,
       sellers (id, store_name, store_image_url, created_at)`
    )
    .eq("user_id", req.params.id);

  if (sellersError) {
    return res.status(500).json({
      error: "Gagal mengambil daftar seller yang difollow.",
      detail: sellersError.message,
    });
  }

  // === Ambil user balance (include bank info)
  const { data: balanceData, error: balanceError } = await supabase
    .from("user_balances")
    .select(
      "balance, updated_at, bank_code, account_holder_name, account_number"
    )
    .eq("user_id", req.params.id)
    .maybeSingle();

  if (balanceError) {
    return res.status(500).json({
      error: "Gagal mengambil data balance.",
      detail: balanceError.message,
    });
  }

  res.json({
    user: {
      ...user,
      alamat_lengkap_combine,
      total_following: totalFollowing || 0,
      following_sellers: followingSellers?.map((f) => f.sellers) || [],
      balance: balanceData
        ? {
            balance: balanceData.balance,
            updated_at: balanceData.updated_at,
            bank_code: balanceData.bank_code,
            account_holder_name: balanceData.account_holder_name,
            account_number: balanceData.account_number,
          }
        : null,
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

router.put("/user/:id", upload.single("avatar"), async (req, res) => {
  try {
    const userId = req.params.id;
    console.log(`[START] Updating user with ID: ${userId}`);

    // Extract fields from req.body
    const {
      username,
      password,
      nama_penerima,
      no_telepon,
      alamat_lengkap,
      kode_pos,
      provinsi_id,
      provinsi,
      kota_id,
      kota,
      kecamatan_id,
      kecamatan,
      kelurahan_id,
      kelurahan,
      bank_code,
      account_holder_name,
      account_number,
    } = req.body;
    console.log("[INPUT] Request body:", {
      username,
      nama_penerima,
      no_telepon,
      alamat_lengkap,
      kode_pos,
      provinsi_id,
      provinsi,
      kota_id,
      kota,
      kecamatan_id,
      kecamatan,
      kelurahan_id,
      kelurahan,
      bank_code,
      account_holder_name,
      account_number,
    });

    // Validate avatar file
    let avatarUrl = null;
    if (req.file) {
      console.log("[AVATAR] File upload detected:", req.file.originalname);
      const fileExt = path.extname(req.file.originalname).toLowerCase();
      const fileName = `avatar_${userId}_${Date.now()}${fileExt}`;
      console.log("[AVATAR] Generated file name:", fileName);

      // Fetch existing avatar to delete it later
      const { data: existingUser, error: fetchError } = await supabase
        .from("users")
        .select("avatar")
        .eq("id", userId)
        .single();

      if (fetchError) {
        console.error("[SUPABASE ERROR] Failed to fetch existing user:", fetchError.message);
        return res.status(500).json({ error: "Gagal mengambil data pengguna.", detail: fetchError.message });
      }

      // Upload new avatar to Supabase storage
      console.log("[SUPABASE] Uploading file to Supabase storage...");
      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });

      if (uploadError) {
        console.error("[SUPABASE ERROR] Failed to upload avatar:", uploadError.message);
        return res.status(500).json({ error: "Gagal mengunggah avatar.", detail: uploadError.message });
      }
      console.log("[SUPABASE] File uploaded successfully");

      // Get public URL for the uploaded avatar
      console.log("[SUPABASE] Fetching public URL for avatar...");
      const { data: publicUrlData } = supabase.storage
        .from("avatars")
        .getPublicUrl(fileName);
      avatarUrl = publicUrlData.publicUrl;
      console.log("[SUPABASE] Public URL for avatar:", avatarUrl);

      // Delete old avatar if it exists
      if (existingUser?.avatar) {
        const oldFileName = existingUser.avatar.split("/").pop();
        console.log("[SUPABASE] Deleting old avatar:", oldFileName);
        const { error: deleteError } = await supabase.storage
          .from("avatars")
          .remove([oldFileName]);
        if (deleteError) {
          console.error("[SUPABASE WARNING] Failed to delete old avatar:", deleteError.message);
          // Continue despite deletion failure to avoid blocking the update
        } else {
          console.log("[SUPABASE] Old avatar deleted successfully");
        }
      }
    } else {
      console.log("[AVATAR] No file uploaded in this request");
    }

    // Build payload for users table
    const updateUsers = {};
    if (username && username.trim()) {
      updateUsers.username = username.trim();
      console.log("[PAYLOAD] Added username to updateUsers:", username);
    }
    if (password && password.trim()) {
      updateUsers.password = await bcrypt.hash(password, 10);
      console.log("[PAYLOAD] Password hashed and added to updateUsers");
    }
    if (avatarUrl) {
      updateUsers.avatar = avatarUrl;
      console.log("[PAYLOAD] Added avatar to updateUsers:", avatarUrl);
    }
    if (nama_penerima && nama_penerima.trim()) {
      updateUsers.nama_penerima = nama_penerima.trim();
      console.log("[PAYLOAD] Added nama_penerima to updateUsers:", nama_penerima);
    }
    if (no_telepon && no_telepon.trim()) {
      updateUsers.no_telepon = no_telepon.trim();
      console.log("[PAYLOAD] Added no_telepon to updateUsers:", no_telepon);
    }
    if (alamat_lengkap && alamat_lengkap.trim()) {
      updateUsers.alamat_lengkap = alamat_lengkap.trim();
      console.log("[PAYLOAD] Added alamat_lengkap to updateUsers:", alamat_lengkap);
    }
    if (kode_pos && kode_pos.trim()) {
      updateUsers.kode_pos = kode_pos.trim();
      console.log("[PAYLOAD] Added kode_pos to updateUsers:", kode_pos);
    }

    // Handle region fields
    const provId = provinsi_id || provinsi;
    const kotaId = kota_id || kota;
    const kecId = kecamatan_id || kecamatan;
    const kelId = kelurahan_id || kelurahan;
    console.log("[WILAYAH] Region IDs:", { provId, kotaId, kecId, kelId });

    if (provId) {
      console.log(`[API CALL] Fetching province name for ID: ${provId}`);
      const provName = await getWilayahName(
        "https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json",
        provId
      );
      if (provName) {
        updateUsers.provinsi = provName;
        console.log("[API RESULT] Province name:", updateUsers.provinsi);
      } else {
        console.error("[API ERROR] Province name not found for ID:", provId);
        return res.status(400).json({ error: "Provinsi tidak valid." });
      }
    }

    if (kotaId && provId) {
      console.log(`[API CALL] Fetching regency name for province ID: ${provId}, regency ID: ${kotaId}`);
      const kotaName = await getWilayahName(
        `https://www.emsifa.com/api-wilayah-indonesia/api/regencies/${provId}.json`,
        kotaId
      );
      if (kotaName) {
        updateUsers.kota_kabupaten = kotaName;
        console.log("[API RESULT] Regency name:", updateUsers.kota_kabupaten);
      } else {
        console.error("[API ERROR] Regency name not found for ID:", kotaId);
        return res.status(400).json({ error: "Kabupaten/Kota tidak valid." });
      }
    }

    if (kecId && kotaId) {
      console.log(`[API CALL] Fetching district name for regency ID: ${kotaId}, district ID: ${kecId}`);
      const kecName = await getWilayahName(
        `https://www.emsifa.com/api-wilayah-indonesia/api/districts/${kotaId}.json`,
        kecId
      );
      if (kecName) {
        updateUsers.kecamatan = kecName;
        console.log("[API RESULT] District name:", updateUsers.kecamatan);
      } else {
        console.error("[API ERROR] District name not found for ID:", kecId);
        return res.status(400).json({ error: "Kecamatan tidak valid." });
      }
    }

    if (kelId && kecId) {
      console.log(`[API CALL] Fetching village name for district ID: ${kecId}, village ID: ${kelId}`);
      const kelName = await getWilayahName(
        `https://www.emsifa.com/api-wilayah-indonesia/api/villages/${kecId}.json`,
        kelId
      );
      if (kelName) {
        updateUsers.kelurahan = kelName;
        console.log("[API RESULT] Village name:", updateUsers.kelurahan);
      } else {
        console.error("[API ERROR] Village name not found for ID:", kelId);
        return res.status(400).json({ error: "Kelurahan tidak valid." });
      }
    }

    // Build payload for user_balances table
    const updateBalances = {};
    if (bank_code && bank_code.trim()) {
      updateBalances.bank_code = bank_code.trim();
      console.log("[PAYLOAD] Added bank_code to updateBalances:", bank_code);
    }
    if (account_holder_name && account_holder_name.trim()) {
      updateBalances.account_holder_name = account_holder_name.trim();
      console.log("[PAYLOAD] Added account_holder_name to updateBalances:", account_holder_name);
    }
    if (account_number && account_number.trim()) {
      updateBalances.account_number = account_number.trim();
      console.log("[PAYLOAD] Added account_number to updateBalances:", account_number);
    }

    // Save to database
    let userData;
    if (Object.keys(updateUsers).length > 0) {
      console.log("[DATABASE] Updating users table with payload:", updateUsers);
      const { data, error: userError } = await supabase
        .from("users")
        .update(updateUsers)
        .eq("id", userId)
        .select(
          "id, email, username, avatar, provinsi, kota_kabupaten, kecamatan, kelurahan, kode_pos, nama_penerima, no_telepon, alamat_lengkap"
        )
        .single();

      if (userError) {
        console.error("[DATABASE ERROR] Failed to update users table:", userError.message);
        return res.status(500).json({ error: "Gagal memperbarui data pengguna.", detail: userError.message });
      }
      userData = data;
      console.log("[DATABASE] Users table updated successfully:", userData);
    } else {
      console.log("[DATABASE] No changes for users table, fetching current data");
      const { data, error: fetchError } = await supabase
        .from("users")
        .select(
          "id, email, username, avatar, provinsi, kota_kabupaten, kecamatan, kelurahan, kode_pos, nama_penerima, no_telepon, alamat_lengkap"
        )
        .eq("id", userId)
        .single();

      if (fetchError) {
        console.error("[DATABASE ERROR] Failed to fetch users table:", fetchError.message);
        return res.status(500).json({ error: "Gagal mengambil data pengguna.", detail: fetchError.message });
      }
      userData = data;
      console.log("[DATABASE] Users data fetched successfully:", userData);
    }

    if (Object.keys(updateBalances).length > 0) {
      console.log("[DATABASE] Updating user_balances table with payload:", updateBalances);
      const { error: balanceError } = await supabase
        .from("user_balances")
        .upsert(
          { user_id: userId, ...updateBalances },
          { onConflict: "user_id" }
        );

      if (balanceError) {
        console.error("[DATABASE ERROR] Failed to update user_balances table:", balanceError.message);
        return res.status(500).json({ error: "Gagal memperbarui data saldo.", detail: balanceError.message });
      }
      console.log("[DATABASE] user_balances table updated successfully");
    }

    // Fetch updated balance data to include in response
    const { data: balanceData, error: balanceFetchError } = await supabase
      .from("user_balances")
      .select("bank_code, account_holder_name, account_number")
      .eq("user_id", userId)
      .single();

    if (balanceFetchError) {
      console.error("[DATABASE ERROR] Failed to fetch user_balances:", balanceFetchError.message);
      // Continue without balance data to avoid blocking response
    }

    console.log("[SUCCESS] User update completed for ID:", userId);
    res.json({
      message: "✅ User berhasil diupdate.",
      user: {
        ...userData,
        balance: balanceData || {},
      },
    });
  } catch (err) {
    console.error("[ERROR] Update user failed:", err.message);
    res.status(500).json({ error: "Gagal update user.", detail: err.message });
  }
});
// ======================== DELETE USER ========================
router.delete("/user/:id", async (req, res) => {
  const cookie = req.cookies.user_info;
  if (!cookie) return res.status(401).json({ error: "Tidak ada sesi login." });

  let userInfo;
  try {
    userInfo = JSON.parse(cookie);
  } catch {
    return res.status(400).json({ error: "Cookie tidak valid." });
  }

  if (userInfo.id !== req.params.id) {
    return res.status(403).json({ error: "Tidak boleh hapus user lain." });
  }

  try {
    // Hapus user dengan CASCADE menggunakan raw SQL
    const { error } = await supabase.rpc("delete_user_cascade", {
  p_user_id: req.params.id
});


    if (error) throw error;

    // Hapus cookie
    res.clearCookie("user_info");
    res.json({ message: "User berhasil dihapus beserta semua data terkait." });
  } catch (err) {
    console.error("Delete user error:", err);
    res.status(500).json({ error: "Gagal menghapus user." });
  }
});

router.post("/login/google", async (req, res) => {
  const { id_token } = req.body;
  console.log("[Google Login] ID token diterima:", id_token);

  if (!id_token) {
    console.log("[Google Login] ID token tidak ditemukan.");
    return res.status(400).json({ error: "ID token Google tidak ditemukan." });
  }

  try {
    // 1. Verify token langsung ke Google
    console.log("[Google Login] Verifikasi ID token ke Google...");
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    console.log("[Google Login] Payload dari Google:", payload);

    const email = payload.email;
    const googleAvatar = payload.picture || null;

    // 2. Cek user di Supabase
    console.log(`[Google Login] Mencari user di Supabase dengan email: ${email}`);
    let { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (error) console.log("[Google Login] Error saat cek user:", error);
    else console.log("[Google Login] User ditemukan:", user);

    // 3. User baru → buat user + OTP
    if (!user) {
      console.log("[Google Login] User baru, buat user + OTP...");
      const username = email.split("@")[0];
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: insertErr, data: newUser } = await supabase
        .from("users")
        .insert([
          {
            email,
            username,
            password: null,
            otp_code: otp,
            otp_expires_at: expiresAt,
            verified: false,
            avatar: googleAvatar,
          },
        ])
        .select()
        .single();

      if (insertErr) {
        console.log("[Google Login] Gagal menyimpan user:", insertErr);
        return res.status(500).json({ error: "Gagal menyimpan user." });
      }

      console.log("[Google Login] User baru berhasil dibuat:", newUser);

      // 🚀 Kirim OTP lewat SMTP server
      await axios.post(`${SEND_URL}/send-email`, {
        type: "otp",
        email,
        code: otp,
      });

      console.log("[Google Login] OTP dikirim ke email:", email);

      return res.status(201).json({
        success: true,
        step: "verify_otp",
        message: "User baru dibuat. OTP dikirim ke email.",
        email,
        avatar: googleAvatar,
      });
    }

    // 4. User belum verified → OTP ulang
    if (!user.verified) {
      console.log("[Google Login] User belum verified, kirim ulang OTP...");
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: updateErr } = await supabase
        .from("users")
        .update({ otp_code: otp, otp_expires_at: expiresAt })
        .eq("email", email);

      if (updateErr) {
        console.log("[Google Login] Gagal memperbarui OTP:", updateErr);
        return res.status(500).json({ error: "Gagal memperbarui OTP." });
      }

      // 🚀 Kirim ulang OTP lewat SMTP microservice
      await axios.post(`${SEND_URL}/send-email`, {
        type: "otp",
        email,
        code: otp,
      });

      console.log("[Google Login] OTP dikirim ulang ke email:", email);

      return res.json({
        success: true,
        step: "verify_otp",
        message: "OTP dikirim ulang. Silakan verifikasi.",
        email,
        avatar: user.avatar || googleAvatar,
      });
    }

    // 5. User verified → cek apakah seller dari tabel sellers berdasarkan email
    console.log("[Google Login] User sudah verified, cek apakah seller...");
    const { data: seller, error: sellerError } = await supabase
      .from("sellers")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (sellerError) {
      console.error("[Google Login] Error cek seller:", sellerError);
    }

    const sellerId = seller ? seller.id : null;

    // 6. Buat JWT + set cookie
    console.log("[Google Login] User verified, buat JWT...");
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "None",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };

    res.cookie(
      "user_info",
      JSON.stringify({
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar || googleAvatar,
        seller_id: sellerId, // 🔑 seller_id hasil query dari sellers.email
      }),
      cookieOptions
    );

    console.log("[Google Login] Login sukses, cookie dan token sudah dibuat untuk user:", user.id);
    return res.json({
      message: "Login Google sukses.",
      token,
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar || googleAvatar,
      seller_id: sellerId,
    });
  } catch (err) {
    console.error("[Google Login] Kesalahan server:", err);
    return res.status(500).json({ error: "Kesalahan server." });
  }
});


module.exports = router;
