const express = require("express");
const path = require("path");
const multer = require("multer");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const supabase = require("../../config/supabase");
const { generateOtp } = require("../../utils/otp");
const axios = require("axios");
const sharp = require("sharp");
const bcrypt = require("bcrypt"); // Added for password hashing

const router = express.Router();

// === Helper Ambil Nama Wilayah ===
async function getWilayahName(url, id) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal fetch wilayah: ${res.status}`);
  const data = await res.json();
  const found = data.find((item) => String(item.id) === String(id));
  return found ? found.name : null;
}

// === Helper Generate Username ===
function generateUsername(email) {
  const base = email.split("@")[0];
  const rand = Math.floor(100 + Math.random() * 900); // 3 digit random
  return `${base}_${rand}`;
}

// Multer setup
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "image/jpeg" || file.mimetype === "image/png") {
      cb(null, true);
    } else {
      cb(new Error("❌ Gambar harus JPEG atau PNG"));
    }
  },
});

const SEND_URL = process.env.SEND_SERVICE_URL;

// POST /forum-pendaftaran/seller
router.post("/seller", upload.single("storeImage"), async (req, res) => {
  try {
    const {
      email,
      name,
      businessName,
      phone,
      storeName,
      storeAddress,
      provinsi_id,
      kota_id,
      kecamatan_id,
      kelurahan_id,
      latitude,
      longitude,
      is_delivery_available,
      delivery_fee,
      password, // Added password from form
    } = req.body;

    // === Validasi field wajib dasar ===
    if (
      !email ||
      !name ||
      !businessName ||
      !phone ||
      !storeName ||
      !storeAddress ||
      !provinsi_id ||
      !kota_id ||
      !kecamatan_id ||
      !kelurahan_id ||
      !latitude ||
      !longitude ||
      typeof is_delivery_available === "undefined" ||
      !req.file ||
      !password
    ) {
      return res.status(400).json({
        message: "❌ Semua field wajib diisi termasuk gambar, koordinat, dan kata sandi",
      });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "❌ Email tidak valid" });
    }

    // Validate phone format
    if (!/^\d{10,13}$/.test(phone)) {
      return res.status(400).json({ message: "❌ Nomor telepon harus 10-13 digit" });
    }

    // Validate password strength
    if (
      password.length < 8 ||
      !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(password)
    ) {
      return res.status(400).json({
        message: "❌ Kata sandi harus minimal 8 karakter, mengandung huruf besar, huruf kecil, angka, dan karakter khusus",
      });
    }

    const isDelivery = String(is_delivery_available).toLowerCase() === "true";

    if (isDelivery && (delivery_fee === undefined || delivery_fee === "" || isNaN(parseFloat(delivery_fee)) || parseFloat(delivery_fee) < 0)) {
      return res.status(400).json({
        message: "❌ Biaya pengiriman harus berupa angka non-negatif jika pengiriman tersedia",
      });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ message: "❌ Koordinat tidak valid" });
    }

    // Ambil nama wilayah
    const provinsi = await getWilayahName(
      "https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json",
      provinsi_id
    );
    const kabupaten = await getWilayahName(
      `https://www.emsifa.com/api-wilayah-indonesia/api/regencies/${provinsi_id}.json`,
      kota_id
    );
    const kecamatan = await getWilayahName(
      `https://www.emsifa.com/api-wilayah-indonesia/api/districts/${kota_id}.json`,
      kecamatan_id
    );
    const kelurahan = await getWilayahName(
      `https://www.emsifa.com/api-wilayah-indonesia/api/villages/${kecamatan_id}.json`,
      kelurahan_id
    );

    if (!provinsi || !kabupaten || !kecamatan || !kelurahan) {
      return res.status(400).json({ message: "❌ Data wilayah tidak valid" });
    }

    // Cek duplikat storeName di tabel sellers
    const { data: existingStore } = await supabase
      .from("sellers")
      .select("store_name")
      .eq("store_name", storeName)
      .single();

    if (existingStore) {
      return res.status(409).json({ message: "❌ Nama toko sudah digunakan, silakan pilih nama lain" });
    }

    // Cek email di sellers
    const { data: existingSeller } = await supabase
      .from("sellers")
      .select("email")
      .eq("email", email)
      .single();

    if (existingSeller) {
      return res.status(409).json({ message: "❌ Email sudah terdaftar sebagai seller" });
    }

    // Upload store image
    const fileExt = path.extname(req.file.originalname);
    const fileName = `${uuidv4()}${fileExt}`;
    const bucketPath = `store-photos/${email.replace(/[@.]/g, "_")}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from("store-photos")
      .upload(bucketPath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      return res.status(500).json({
        message: "❌ Gagal upload gambar ke Supabase",
        error: uploadError.message,
      });
    }

    const { data: publicUrlData } = supabase.storage
      .from("store-photos")
      .getPublicUrl(bucketPath);
    const storeImageUrl = publicUrlData.publicUrl;

    // Simpan seller
    const { data: newSeller, error: insertError } = await supabase
      .from("sellers")
      .insert([
        {
          email,
          name,
          business_name: businessName,
          phone,
          store_name: storeName,
          store_address: storeAddress,
          provinsi,
          kabupaten,
          kecamatan,
          kelurahan,
          latitude: lat,
          longitude: lng,
          is_delivery_available: isDelivery,
          delivery_fee: isDelivery ? parseFloat(delivery_fee) : null,
          store_image_url: storeImageUrl,
          role: "seller",
        },
      ])
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({
        message: "❌ Gagal simpan seller ke Supabase",
        error: insertError.message,
      });
    }

    // Cek apakah user sudah ada
    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    let username = generateUsername(email);
    let otpCode = generateOtp(); // Use provided generateOtp function
    const hashedPassword = await bcrypt.hash(password, 10); // Hash the provided password

    // Upload default avatar
    const defaultImagePath = path.join(__dirname, "../assets/user.png");
    const avatarFilename = `avatar_default_${Date.now()}.webp`;
    const avatarBuffer = await sharp(defaultImagePath)
      .resize(256, 256)
      .webp({ quality: 80 })
      .toBuffer();

    const { error: avatarUploadError } = await supabase.storage
      .from("avatars")
      .upload(avatarFilename, avatarBuffer, {
        contentType: "image/webp",
        upsert: true,
      });

    if (avatarUploadError) {
      return res.status(500).json({
        message: "❌ Gagal upload default avatar",
        error: avatarUploadError.message,
      });
    }

    const { data: avatarUrlData } = supabase.storage
      .from("avatars")
      .getPublicUrl(avatarFilename);
    const avatarUrl = avatarUrlData.publicUrl;

    if (!existingUser) {
      // Simpan user baru
      const { error: userInsertError } = await supabase.from("users").insert([
        {
          email,
          username,
          password: hashedPassword,
          otp_code: otpCode,
          otp_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          avatar: avatarUrl,
        },
      ]);

      if (userInsertError) {
        return res.status(500).json({
          message: "❌ Seller tersimpan tapi gagal simpan user/OTP",
          error: userInsertError.message,
        });
      }
    } else {
      // Update user yang sudah ada dengan password baru dan OTP
      const { error: userUpdateError } = await supabase
        .from("users")
        .update({
          password: hashedPassword,
          otp_code: otpCode,
          otp_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        })
        .eq("email", email);

      if (userUpdateError) {
        return res.status(500).json({
          message: "❌ Seller tersimpan tapi gagal update user/OTP",
          error: userUpdateError.message,
        });
      }
      username = existingUser.username;
    }

    // Kirim OTP lewat SMTP microservice
    await axios.post(`${SEND_URL}/send-email`, {
      type: "otp",
      email,
      code: otpCode,
    });

    return res.status(201).json({
      message: "✅ Seller berhasil didaftarkan & OTP dikirim ke email",
      storeImageUrl,
      seller: newSeller,
      user: {
        email,
        username,
        avatar: avatarUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({
      message: "❌ Gagal proses pendaftaran",
      error: error.message,
    });
  }
});

module.exports = router;