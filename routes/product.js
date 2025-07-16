// 🔁 Migrasi Express Router Produk ke Supabase
const express = require('express');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');

const router = express.Router();

// 📦 Multer setup
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('❌ Gambar harus JPEG atau PNG'));
    }
  }
});

// 🧾 POST /upload (unggah produk baru)
router.post('/upload', upload.single('productImage'), async (req, res) => {
  const {
    seller_id,
    productName,
    productDescription,
    productPrice
  } = req.body;

  if (!seller_id || !productName || !productDescription || !productPrice || !req.file) {
    return res.status(400).json({ message: '❌ Semua field wajib diisi termasuk gambar' });
  }

  const priceNum = parseFloat(productPrice);
  if (isNaN(priceNum) || priceNum <= 0) {
    return res.status(400).json({ message: '❌ Harga harus valid dan > 0' });
  }

  try {
    // 🔍 Cari seller
    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('*')
      .eq('id', seller_id)
      .single();

    if (sellerError || !seller) {
      return res.status(404).json({ message: '❌ Seller tidak ditemukan' });
    }

    // 📤 Upload ke Supabase Storage
    const fileExt = path.extname(req.file.originalname);
    const fileName = `${uuidv4()}${fileExt}`;
    const filePath = `${seller_id}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('product-images')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
      });

    if (uploadError) {
      return res.status(500).json({ message: '❌ Gagal upload gambar', error: uploadError.message });
    }

    // ✅ Buat signed URL (7 hari)
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from('product-images')
      .createSignedUrl(filePath, 60 * 60 * 24 * 7000000); // 7 hari

    if (signedUrlError) {
      return res.status(500).json({ message: '❌ Gagal generate signed URL', error: signedUrlError.message });
    }

    // 💾 Simpan ke tabel products
    const { data: product, error: insertError } = await supabase
      .from('products')
      .insert([{
        seller_id,
        seller_name: seller.name,
        seller_email: seller.email,
        product_name: productName,
        product_description: productDescription,
        product_price: priceNum,
        product_image_url: signedUrlData.signedUrl
      }])
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ message: '❌ Gagal simpan produk', error: insertError.message });
    }

    return res.status(201).json({ message: '✅ Produk berhasil diunggah', data: product });
  } catch (error) {
    return res.status(500).json({ message: '❌ Terjadi error', error: error.message });
  }
});

// 🔎 Haversine Distance
const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// 🔍 Produk terdekat
router.get('/nearby-by-location', async (req, res) => {
  const { lat, lng } = req.query;

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  if (isNaN(userLat) || isNaN(userLng)) {
    return res.status(400).json({ message: '❌ Koordinat tidak valid' });
  }

  try {
    const { data: sellers, error: sellerErr } = await supabase
      .from('sellers')
      .select('id, name, latitude, longitude');

    const { data: products, error: productErr } = await supabase
      .from('products')
      .select('*');

    if (sellerErr || productErr || !sellers || !products) {
      return res.status(500).json({ message: '❌ Gagal ambil data dari Supabase' });
    }

    const merged = products.map((product) => {
      const seller = sellers.find((s) => s.id === product.seller_id);
      const distanceInKm =
        seller && seller.latitude && seller.longitude
          ? haversineDistance(userLat, userLng, seller.latitude, seller.longitude)
          : Infinity;

      return {
        ...product,
        sellerName: seller?.name,
        distanceInKm: +distanceInKm.toFixed(2)
      };
    }).filter(p => p.distanceInKm <= 40);

    return res.status(200).json({
      message: `✅ Ditemukan ${merged.length} produk dalam radius 40 km`,
      products: merged
    });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal mengambil produk', error: error.message });
  }
});


// 📦 Semua produk
router.get('/allproduct', async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('*');

    if (error) throw error;

    return res.status(200).json({
      message: `✅ Ditemukan ${products.length} produk`,
      products
    });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal mengambil semua produk', error: error.message });
  }
});

module.exports = router;
