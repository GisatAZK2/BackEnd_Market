const express = require("express");
const path = require("path");
const multer = require("multer");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const supabase = require("../../config/supabase");

const router = express.Router();

// === Helper Ambil Nama Wilayah ===
async function getWilayahName(url, id) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal fetch wilayah: ${res.status}`);
  const data = await res.json();
  const found = data.find((item) => String(item.id) === String(id));
  return found ? found.name : null;
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

    // === Validasi field wajib dasar (tanpa delivery_fee) ===
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

    // Konversi ke boolean
    const isDelivery =
      String(is_delivery_available).toLowerCase() === "true";

    // Validasi khusus delivery fee
    if (isDelivery && (delivery_fee === undefined || delivery_fee === "")) {
      return res.status(400).json({
        message: "❌ delivery_fee wajib diisi jika pengiriman tersedia",
      });
    }

    // Koordinat
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ message: "❌ Koordinat tidak valid" });
    }

    // Ambil nama wilayah dari ID
    const provinsi = await getWilayahName(
      "https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json",
      provinsi_id,
    );
    const kabupaten = await getWilayahName(
      `https://www.emsifa.com/api-wilayah-indonesia/api/regencies/${provinsi_id}.json`,
      kota_id,
    );
    const kecamatan = await getWilayahName(
      `https://www.emsifa.com/api-wilayah-indonesia/api/districts/${kota_id}.json`,
      kecamatan_id,
    );
    const kelurahan = await getWilayahName(
      `https://www.emsifa.com/api-wilayah-indonesia/api/villages/${kecamatan_id}.json`,
      kelurahan_id,
    );

    if (!provinsi || !kabupaten || !kecamatan || !kelurahan) {
      return res.status(400).json({ message: "❌ Data wilayah tidak valid" });
    }

    // Cek email sudah ada
    const { data: existing } = await supabase
      .from("sellers")
      .select("email")
      .eq("email", email)
      .single();

    if (existing) {
      return res
        .status(409)
        .json({ message: "❌ Email sudah terdaftar sebagai seller" });
    }

    // Upload gambar ke Supabase Storage
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

    // Ambil URL publik
    const { data: publicUrlData } = supabase.storage
      .from("store-photos")
      .getPublicUrl(bucketPath);

    const publicUrl = publicUrlData.publicUrl;

    // Simpan seller ke database
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
          store_image_url: publicUrl,
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

    return res.status(201).json({
      message: "✅ Seller berhasil didaftarkan",
      imageUrl: publicUrl,
      seller: newSeller,
    });
  } catch (error) {
    return res.status(500).json({
      message: "❌ Gagal proses pendaftaran",
      error: error.message,
    });
  }
});

module.exports = router;
