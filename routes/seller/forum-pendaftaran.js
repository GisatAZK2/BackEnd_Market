const express = require("express");
const path = require("path");
const multer = require("multer");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const supabase = require("../../config/supabase");
const axios = require("axios");
const sharp = require("sharp");
const jwt = require("jsonwebtoken");

const router = express.Router();

// === Helper Ambil Nama Wilayah ===
async function getWilayahName(url, id) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gagal fetch wilayah: ${res.status}`);
    const data = await res.json();
    const found = data.find((item) => String(item.id) === String(id));
    return found ? found.name : null;
  } catch (error) {
    throw new Error(`Error fetching wilayah: ${error.message}`);
  }
}

// === Helper Generate Username ===
function generateUsername(email) {
  const base = email.split("@")[0];
  const rand = Math.floor(100 + Math.random() * 900); // 3 digit random
  return `${base}_${rand}`;
}

// === Helper Generate Password (10 karakter random) ===
function generatePassword(length = 10) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let pwd = "";
  for (let i = 0; i < length; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
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
      !req.file
    ) {
      return res.status(400).json({
        message: "❌ Semua field wajib diisi termasuk gambar dan koordinat",
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
    let password = generatePassword(10);
    let otpCode = Math.floor(100000 + Math.random() * 900000); // 6 digit

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
          password,
          otp_code: otpCode,
          otp_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          avatar: avatarUrl,
          verified: false, // Default to false for new users
        },
      ]);

      if (userInsertError) {
        return res.status(500).json({
          message: "❌ Seller tersimpan tapi gagal simpan user/OTP",
          error: userInsertError.message,
        });
      }
    } else {
      // Update OTP user yang sudah ada
      const { error: otpUpdateError } = await supabase
        .from("users")
        .update({
          otp_code: otpCode,
          otp_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        })
        .eq("email", email);

      if (otpUpdateError) {
        return res.status(500).json({
          message: "❌ Seller tersimpan tapi gagal update OTP user",
          error: otpUpdateError.message,
        });
      }
      username = existingUser.username;
      password = "(password tetap sama)";
    }

    // Kirim OTP lewat SMTP microservice
    try {
      const otpResponse = await axios.post(`${SEND_URL}/send-email`, {
        type: "otp",
        email,
        code: otpCode,
      });

      if (otpResponse.status !== 200) {
        return res.status(500).json({
          message: "❌ Seller tersimpan tapi gagal mengirim OTP",
          error: "Failed to send OTP via microservice",
        });
      }
    } catch (otpError) {
      return res.status(500).json({
        message: "❌ Seller tersimpan tapi gagal mengirim OTP",
        error: `OTP microservice error: ${otpError.message}`,
      });
    }

    // Generate JWT token
    const token = jwt.sign({ id: existingUser ? existingUser.id : newSeller.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    // Check verification status and set seller_info cookie if verified
    const { data: userForCookie } = await supabase
      .from("users")
      .select("id, verified")
      .eq("email", email)
      .single();

    let responseData = {
      message: "✅ Seller berhasil didaftarkan & OTP dikirim ke email",
      storeImageUrl,
      seller: newSeller,
      user: {
        email,
        username,
        password: `password sementara ${password}`,
        avatar: avatarUrl,
      },
      token,
    };

    if (userForCookie && userForCookie.verified) {
      res.cookie(
        "seller_info",
        JSON.stringify({
          id: newSeller.id,
          email: newSeller.email,
          store_name: newSeller.store_name,
        }),
        {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "None",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        }
      );
      responseData.seller_info = {
        id: newSeller.id,
        email: newSeller.email,
        store_name: newSeller.store_name,
      };
    }

    return res.status(201).json(responseData);
  } catch (error) {
    return res.status(500).json({
      message: "❌ Gagal proses pendaftaran",
      error: error.message,
    });
  }
});

module.exports = router;