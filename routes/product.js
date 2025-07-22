// 🔁 Migrasi Express Router Produk ke Supabase
const express = require('express');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const generateKeywords = require('../utils/keywordGenerator');

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
    productPrice,
    category_id,
    stock,
    variants // ← dikirim dalam bentuk string JSON
  } = req.body;

  if (
    !seller_id ||
    !productName ||
    !productDescription ||
    !productPrice ||
    !category_id ||
    !req.file
  ) {
    return res.status(400).json({
      message: '❌ Semua field wajib diisi termasuk gambar'
    });
  }

  const priceNum = parseFloat(productPrice);
  const stockNum = parseInt(stock) || 0;

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

    // 📤 Upload gambar utama ke Supabase Storage
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

    // ✅ Buat signed URL gambar produk utama (7 hari)
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from('product-images')
      .createSignedUrl(filePath, 60 * 60 * 24 * 7); // 7 hari

    if (signedUrlError) {
      return res.status(500).json({ message: '❌ Gagal generate signed URL', error: signedUrlError.message });
    }

    const keywords = [
      ...generateKeywords(productName),
      ...generateKeywords(productDescription)
    ];

    // 💾 Simpan ke tabel products
    const { data: product, error: insertError } = await supabase
      .from('products')
      .insert([{
        seller_id,
        category_id,
        seller_name: seller.name,
        seller_email: seller.email,
        product_name: productName,
        product_description: productDescription,
        product_price: priceNum,
        stock: stockNum,
        product_image_url: signedUrlData.signedUrl,
        keywords
      }])
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ message: '❌ Gagal simpan produk', error: insertError.message });
    }

    // 📦 Simpan varian jika ada
    if (variants) {
      let parsedVariants;
      try {
        parsedVariants = JSON.parse(variants); // Harus array
      } catch (parseErr) {
        return res.status(400).json({ message: '❌ Format varian tidak valid (bukan JSON)' });
      }

      if (!Array.isArray(parsedVariants)) {
        return res.status(400).json({ message: '❌ Varian harus berupa array' });
      }

      const variantData = parsedVariants.map(v => ({
        product_id: product.id,
        variant_name: v.name,
        variant_price: parseFloat(v.price),
        variant_stock: parseInt(v.stock),
        variant_image_url: v.image_url || null
      }));

      const { error: variantInsertError } = await supabase
        .from('product_variants')
        .insert(variantData);

      if (variantInsertError) {
        return res.status(500).json({ message: '❌ Gagal simpan varian', error: variantInsertError.message });
      }
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

// 🧲 Produk berdasarkan kategori
router.get('/by-category/:category_id', async (req, res) => {
  const { category_id } = req.params;

  if (!category_id) {
    return res.status(400).json({ message: '❌ category_id diperlukan' });
  }

  try {
    // 🔍 Ambil kategori dulu (opsional, untuk validasi)
    const { data: category, error: categoryError } = await supabase
      .from('categories')
      .select('id, name')
      .eq('id', category_id)
      .single();

    if (categoryError || !category) {
      return res.status(404).json({ message: '❌ Kategori tidak ditemukan' });
    }

    // 🛍 Ambil produk berdasarkan kategori
    const { data: products, error: productError } = await supabase
      .from('products')
      .select('*')
      .eq('category_id', category_id);

    if (productError) {
      return res.status(500).json({ message: '❌ Gagal ambil produk', error: productError.message });
    }

    return res.status(200).json({
      message: `✅ Ditemukan ${products.length} produk dalam kategori "${category.name}"`,
      category: category.name,
      products
    });
  } catch (error) {
    return res.status(500).json({ message: '❌ Server error', error: error.message });
  }
});

// 🔍 Get produk by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !product) {
      return res.status(404).json({ message: '❌ Produk tidak ditemukan' });
    }

    return res.status(200).json({ message: '✅ Produk ditemukan', product });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal mengambil produk', error: error.message });
  }
});

// ✏️ Edit produk
router.put('/:id', upload.single('productImage'), async (req, res) => {
  const { id } = req.params;
  const {
    productName,
    productDescription,
    productPrice,
    category_id
  } = req.body;

  const priceNum = parseFloat(productPrice);

  if (isNaN(priceNum) || priceNum <= 0) {
    return res.status(400).json({ message: '❌ Harga tidak valid' });
  }

  try {
    // Ambil produk dulu
    const { data: existing, error: findErr } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (findErr || !existing) {
      return res.status(404).json({ message: '❌ Produk tidak ditemukan' });
    }

    let imageUrl = existing.product_image_url;

    // Kalau ada file gambar baru
    if (req.file) {
      // Upload ke Supabase Storage
      const fileExt = path.extname(req.file.originalname);
      const fileName = `${uuidv4()}${fileExt}`;
      const filePath = `${existing.seller_id}/${fileName}`;

      const { error: uploadErr } = await supabase.storage
        .from('product-images')
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true
        });

      if (uploadErr) {
        return res.status(500).json({ message: '❌ Gagal upload gambar baru', error: uploadErr.message });
      }

      // Buat signed URL baru
      const { data: signedUrlData, error: signedUrlErr } = await supabase.storage
        .from('product-images')
        .createSignedUrl(filePath, 60 * 60 * 24 * 7);

      if (signedUrlErr) {
        return res.status(500).json({ message: '❌ Gagal generate signed URL', error: signedUrlErr.message });
      }

      imageUrl = signedUrlData.signedUrl;
    }

    const keywords = [
      ...generateKeywords(productName),
      ...generateKeywords(productDescription)
    ];

    // Update data
    const { data: updated, error: updateErr } = await supabase
      .from('products')
      .update({
        product_name: productName,
        product_description: productDescription,
        product_price: priceNum,
        category_id,
        product_image_url: imageUrl,
        keywords
      })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ message: '❌ Gagal update produk', error: updateErr.message });
    }

    return res.status(200).json({ message: '✅ Produk berhasil diupdate', product: updated });
  } catch (error) {
    return res.status(500).json({ message: '❌ Terjadi error', error: error.message });
  }
});

// ❌ Hapus produk
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: product, error: findErr } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (findErr || !product) {
      return res.status(404).json({ message: '❌ Produk tidak ditemukan' });
    }

    // Ambil path dari URL
    const imagePath = decodeURIComponent(new URL(product.product_image_url).pathname.split('/storage/v1/object/public/product-images/')[1]);

    // Hapus dari storage
    const { error: deleteFileErr } = await supabase
      .storage
      .from('product-images')
      .remove([imagePath]);

    if (deleteFileErr) {
      return res.status(500).json({ message: '❌ Gagal hapus gambar', error: deleteFileErr.message });
    }

    // Hapus dari DB
    const { error: deleteErr } = await supabase
      .from('products')
      .delete()
      .eq('id', id);

    if (deleteErr) {
      return res.status(500).json({ message: '❌ Gagal hapus produk', error: deleteErr.message });
    }

    return res.status(200).json({ message: '✅ Produk berhasil dihapus' });
  } catch (error) {
    return res.status(500).json({ message: '❌ Terjadi error saat menghapus produk', error: error.message });
  }
});



module.exports = router;
