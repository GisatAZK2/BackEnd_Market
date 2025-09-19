const express = require("express");
const path = require("path");
const multer = require("multer");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const supabase = require("../../config/supabase");
const axios = require("axios");
const bcrypt = require("bcrypt");
const sharp = require("sharp");

const router = express.Router();

// === Helper Ambil Nama Wilayah ===
async function getWilayahName(url, id) {
  console.log(`🌍 Fetching wilayah dari: ${url}, id: ${id}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal fetch wilayah: ${res.status}`);
  const data = await res.json();
  const found = data.find((item) => String(item.id) === String(id));
  console.log(`✅ Hasil wilayah (${id}):`, found ? found.name : null);
  return found ? found.name : null;
}

// === Helper Generate Username ===
function generateUsername(email) {
  const base = email.split("@")[0];
  const rand = Math.floor(100 + Math.random() * 900); // 3 digit random
  return `${base}_${rand}`;
}

// Multer setup for store image
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

// POST /forum-pendaftaran/seller (Seller Registration)
router.post(
  "/seller",
  uploadStoreImage.single("storeImage"),
  async (req, res) => {
    try {
      console.log("📥 Request body:", req.body);
      console.log(
        "📸 File upload:",
        req.file ? req.file.originalname : "❌ Tidak ada file"
      );

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
        password,
        username,
        // opsional
        pin,
        bankCode,
        accountHolderName,
        accountNumber,
      } = req.body;

      // === Validate required fields (tanpa pin & bank info)
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
        console.log("❌ Validasi gagal, ada field kosong");
        return res.status(400).json({
          error:
            "Semua field wajib diisi termasuk gambar, koordinat, dan password.",
        });
      }

      const isDelivery = String(is_delivery_available).toLowerCase() === "true";
      if (isDelivery && (delivery_fee === undefined || delivery_fee === "")) {
        console.log("❌ delivery_fee kosong padahal delivery true");
        return res.status(400).json({
          error: "delivery_fee wajib diisi jika pengiriman tersedia.",
        });
      }

      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      if (isNaN(lat) || isNaN(lng)) {
        console.log("❌ Koordinat tidak valid:", latitude, longitude);
        return res.status(400).json({ error: "Koordinat tidak valid." });
      }

      // === Validate password strength
      if (
        password.length < 1 ||
        !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(
          password
        )
      ) {
        console.log("❌ Password tidak valid");
        return res
          .status(400)
          .json({ error: "Password tidak memenuhi persyaratan keamanan." });
      }

      // === PIN opsional (kalau ada → wajib 4-6 digit)
      let hashedPin = null;
      if (pin) {
        if (pin.toString().length < 4 || pin.toString().length > 6) {
          console.log("❌ PIN tidak valid:", pin);
          return res.status(400).json({ error: "PIN harus 4-6 digit." });
        }
        hashedPin = await bcrypt.hash(pin.toString(), 12);
      }

      // === Ambil nama wilayah
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
        console.log("❌ Data wilayah tidak valid");
        return res.status(400).json({ error: "Data wilayah tidak valid." });
      }

      // === Cek email di sellers
      console.log("🔍 Cek email seller:", email);
      const { data: existingSeller } = await supabase
        .from("sellers")
        .select("email")
        .eq("email", email)
        .single();

      if (existingSeller) {
        console.log("❌ Email sudah ada di sellers");
        return res
          .status(400)
          .json({ error: "Email sudah terdaftar sebagai seller." });
      }

      // === Cek email di users
      console.log("🔍 Cek email user:", email);
      const { data: existingUser } = await supabase
        .from("users")
        .select("*")
        .eq("email", email)
        .single();

      if (existingUser) {
        console.log("❌ Email sudah ada di users");
        return res
          .status(400)
          .json({ error: "Email sudah digunakan. Silakan gunakan email lain." });
      }

      // === Upload store image
      console.log("📤 Upload store image...");
      const fileExt = path.extname(req.file.originalname);
      const fileName = `store_${uuidv4()}${fileExt}`;
      const bucketPath = `store-photos/${email.replace(/[@.]/g, "_")}/${fileName}`;

      const buffer = await sharp(req.file.buffer)
        .webp({ quality: 80 })
        .toBuffer();

      const { error: uploadError } = await supabase.storage
        .from("store-photos")
        .upload(bucketPath, buffer, {
          contentType: "image/webp",
          upsert: true,
        });

      if (uploadError) {
        console.log("❌ Gagal upload store image:", uploadError);
        return res
          .status(500)
          .json({ error: "Gagal upload gambar toko ke storage." });
      }

      const { data: publicUrlData } = supabase.storage
        .from("store-photos")
        .getPublicUrl(bucketPath);
      const storeImageUrl = publicUrlData.publicUrl;
      console.log("✅ Store image URL:", storeImageUrl);

      // === Hash the provided password
      const hashedPassword = await bcrypt.hash(password, 10);
      const finalUsername =
        username && username.trim() !== ""
          ? username.trim()
          : generateUsername(email);
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      console.log("🔑 Username:", finalUsername, "OTP:", otpCode);

      // === Upload default avatar
      console.log("📤 Upload default avatar...");
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
        console.log("❌ Gagal upload avatar:", avatarUploadError);
        return res
          .status(500)
          .json({ error: "Gagal upload default avatar ke storage." });
      }

      const { data: avatarUrlData } = supabase.storage
        .from("avatars")
        .getPublicUrl(avatarFilename);
      const avatarUrl = avatarUrlData.publicUrl;
      console.log("✅ Avatar URL:", avatarUrl);

      // === Simpan seller
      console.log("💾 Simpan seller...");
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
        console.log("❌ Gagal simpan seller:", insertError);
        return res
          .status(500)
          .json({ error: "Gagal menyimpan seller ke database." });
      }

      // === Simpan user
      console.log("💾 Simpan user...");
      const { error: userInsertError } = await supabase.from("users").insert([
        {
          email,
          username: finalUsername,
          password: hashedPassword,
          otp_code: otpCode,
          otp_expires_at: expiresAt,
          avatar: avatarUrl,
          verified: false,
        },
      ]);

      if (userInsertError) {
        console.log("❌ Gagal simpan user:", userInsertError);
        return res
          .status(500)
          .json({ error: "Gagal menyimpan user ke database." });
      }

      // === Simpan seller balance
      console.log("💾 Simpan seller balance...");
      const balancePayload = {
        seller_id: newSeller.id,
        withdrawable_balance: 0,
      };
      if (hashedPin) balancePayload.seller_pin_hash = hashedPin;
      if (bankCode) balancePayload.bank_code = bankCode;
      if (accountHolderName) balancePayload.account_holder_name = accountHolderName;
      if (accountNumber) balancePayload.account_number = accountNumber;

      const { error: balanceInsertError } = await supabase
        .from("seller_balances")
        .insert([balancePayload]);

      if (balanceInsertError) {
        console.log("❌ Gagal simpan balance:", balanceInsertError);
        return res
          .status(500)
          .json({ error: "Gagal menyimpan saldo seller ke database." });
      }

      // === Kirim OTP
      console.log("📧 Kirim OTP ke email:", email);
      await axios.post(`${process.env.SEND_SERVICE_URL}/send-email`, {
        type: "otp",
        email,
        code: otpCode,
      });

      return res.status(201).json({
        message: "Seller berhasil didaftarkan. OTP dikirim ke email.",
        storeImageUrl,
        seller: newSeller,
        user: { email, username: finalUsername },
      });
    } catch (error) {
      console.error("❌ Register seller error:", error);
      return res.status(500).json({ error: "Terjadi kesalahan pada server." });
    }
  }
);

module.exports = router;
