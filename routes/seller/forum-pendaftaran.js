const express = require("express");
const path = require("path");
const multer = require("multer");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const supabase = require("../../config/supabase");
const { generateOtp } = require("../../utils/otp");
const axios = require("axios");
const bcrypt = require("bcrypt"); // Assuming bcrypt is imported for regular registration
const sharp = require("sharp");


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

// === Helper Generate Password (10 karakter random) ===
function generatePassword(length = 10) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let pwd = "";
  for (let i = 0; i < length; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

// Multer setup for regular registration (avatar)
const uploadAvatar = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "image/jpeg" || file.mimetype === "image/png") {
      cb(null, true);
    } else {
      cb(new Error("❌ Avatar harus JPEG atau PNG"));
    }
  },
});

// Multer setup for seller registration (storeImage)
const uploadStoreImage = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "image/jpeg" || file.mimetype === "image/png") {
      cb(null, true);
    } else {
      cb(new Error("❌ Gambar toko harus JPEG atau PNG"));
    }
  },
});

const SEND_URL = process.env.SEND_SERVICE_URL;
// POST /forum-pendaftaran/seller (Seller Registration)
router.post("/seller", uploadStoreImage.single("storeImage"), async (req, res) => {
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
      password, // Added for seller registration with provided password // For CAPTCHA verification (handle manually or via middleware if needed)
    } = req.body;

    // === Manual CAPTCHA verification (if not using middleware) ===
    // Assuming you have a function verifyCaptchaToken(captchaToken) that calls reCAPTCHA API
    // if (!verifyCaptchaToken(captchaToken)) {
    //   return res.status(400).json({ message: "❌ CAPTCHA tidak valid" });
    // }

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
        message: "❌ Semua field wajib diisi termasuk gambar, koordinat, dan password",
      });
    }

    const isDelivery = String(is_delivery_available).toLowerCase() === "true";

    if (isDelivery && (delivery_fee === undefined || delivery_fee === "")) {
      return res.status(400).json({
        message: "❌ delivery_fee wajib diisi jika pengiriman tersedia",
      });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ message: "❌ Koordinat tidak valid" });
    }

    // Validate password strength (similar to frontend)
    if (password.length < 8 || !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(password)) {
      return res.status(400).json({ message: "❌ Password tidak memenuhi persyaratan keamanan" });
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

    // Cek email di sellers
    const { data: existingSeller } = await supabase
      .from("sellers")
      .select("email")
      .eq("email", email)
      .single();

    if (existingSeller) {
      return res
        .status(409)
        .json({ message: "❌ Email sudah terdaftar sebagai seller" });
    }

    // Cek email di users (to prevent duplicate across systems)
    const { data: existingUser } = await supabase
      .from("users")
      .select("email")
      .eq("email", email)
      .single();

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

    // Hash the provided password
    const hashedPassword = await bcrypt.hash(password, 10);
    let username = generateUsername(email);
    let otpCode = Math.floor(100000 + Math.random() * 900000); // 6 digit

    // Upload default avatar for user (since seller uses store image separately)
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
      return res
        .status(500)
        .json({ message: "❌ Gagal upload default avatar", error: avatarUploadError.message });
    }

    const { data: avatarUrlData } = supabase.storage
      .from("avatars")
      .getPublicUrl(avatarFilename);
    const avatarUrl = avatarUrlData.publicUrl;

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

    if (!existingUser) {
      // Simpan user baru with provided password
      const { error: userInsertError } = await supabase.from("users").insert([
        {
          email,
          username,
          password: hashedPassword,
          otp_code: otpCode,
          otp_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          avatar: avatarUrl,
          verified: false, // Added for consistency with regular registration
        },
      ]);

      if (userInsertError) {
        return res.status(500).json({
          message: "❌ Seller tersimpan tapi gagal simpan user/OTP",
          error: userInsertError.message,
        });
      }
    } else {
      // Update existing user with OTP (but since email is unique, this shouldn't happen due to earlier check)
      // For safety, update OTP
      const { error: otpUpdateError } = await supabase
        .from("users")
        .update({
          otp_code: otpCode,
          otp_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          password: hashedPassword, // Update password if needed, but ideally prevent this case
        })
        .eq("email", email);

      if (otpUpdateError) {
        return res.status(500).json({
          message: "❌ Seller tersimpan tapi gagal update OTP user",
          error: otpUpdateError.message,
        });
      }
      username = existingUser.username;
    }

    // 🚀 Kirim OTP lewat SMTP microservice
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
        // Do not return hashed password, but since frontend doesn't use it, just confirm
      },
    });
  } catch (error) {
    console.error("Register seller error:", error);
    return res.status(500).json({
      message: "❌ Gagal proses pendaftaran",
      error: error.message,
    });
  }
});

module.exports = router;