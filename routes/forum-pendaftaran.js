const express = require('express');
const path = require('path');
const multer = require('multer');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');

const router = express.Router();

// Multer setup
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

// Wilayah API
router.get('/wilayah/provinsi', async (req, res) => {
  try {
    const response = await fetch('https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json');
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: '❌ Gagal ambil data provinsi', error: err.message });
  }
});

router.get('/wilayah/kabupaten/:provinsiId', async (req, res) => {
  try {
    const response = await fetch(`https://www.emsifa.com/api-wilayah-indonesia/api/regencies/${req.params.provinsiId}.json`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: '❌ Gagal ambil data kabupaten', error: err.message });
  }
});

router.get('/wilayah/kecamatan/:kabupatenId', async (req, res) => {
  try {
    const response = await fetch(`https://www.emsifa.com/api-wilayah-indonesia/api/districts/${req.params.kabupatenId}.json`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: '❌ Gagal ambil data kecamatan', error: err.message });
  }
});

router.get('/wilayah/kelurahan/:kecamatanId', async (req, res) => {
  try {
    const response = await fetch(`https://www.emsifa.com/api-wilayah-indonesia/api/villages/${req.params.kecamatanId}.json`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: '❌ Gagal ambil data kelurahan', error: err.message });
  }
});

// POST /forum-pendaftaran/seller
router.post('/seller', upload.single('storeImage'), async (req, res) => {
  const {
    email, name, businessName, phone, storeName, storeAddress,
    kelurahan, kecamatan, kabupaten, provinsi, latitude, longitude
  } = req.body;

  if (!email || !name || !businessName || !phone || !storeName || !storeAddress ||
    !kelurahan || !kecamatan || !kabupaten || !provinsi || !latitude || !longitude || !req.file) {
    return res.status(400).json({ message: '❌ Semua field wajib diisi termasuk gambar dan koordinat' });
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ message: '❌ Koordinat tidak valid' });
  }

  try {
    // Cek email sudah ada
    const { data: existing, error: checkError } = await supabase
      .from('sellers')
      .select('email')
      .eq('email', email)
      .single();

    if (existing) {
      return res.status(409).json({ message: '❌ Email sudah terdaftar sebagai seller' });
    }

    // Upload gambar
    const fileExt = path.extname(req.file.originalname);
    const fileName = `${uuidv4()}${fileExt}`;
    const bucketPath = `store-photos/${email.replace(/[@.]/g, '_')}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('store-photos')
      .upload(bucketPath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
      });

    if (uploadError) {
      return res.status(500).json({ message: '❌ Gagal upload gambar ke Supabase', error: uploadError.message });
    }

    const { data: signedUrlData, error: signedError } = await supabase.storage
  .from('store-photos')
  .createSignedUrl(bucketPath, 60 * 60 * 24 * 700000); // 7 hari valid

    if (signedError || !signedUrlData) {
      return res.status(500).json({ message: '❌ Gagal buat signed URL', error: signedError?.message });
    }


    const { error: insertError, data: newSeller } = await supabase
      .from('sellers')
      .insert([{
        email,
        name,
        business_name: businessName,
        phone,
        store_name: storeName,
        store_address: storeAddress,
        kelurahan,
        kecamatan,
        kabupaten,
        provinsi,
        latitude: lat,
        longitude: lng,
        store_image_url: signedUrlData.signedUrl,
        role: 'seller'
      }])
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ message: '❌ Gagal simpan seller ke Supabase', error: insertError.message });
    }

    return res.status(201).json({
      message: '✅ Seller berhasil didaftarkan',
      imageUrl: signedUrlData.signedUrl,
      seller: newSeller
    });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal proses pendaftaran', error: error.message });
  }
});

module.exports = router;
