// 📦 REFACTOR: forum-pendaftaran.js dengan MongoDB
const express = require('express');
const path = require('path');
const ImageKit = require('imagekit');
const multer = require('multer');
const fetch = require('node-fetch');
const Seller = require('../models/Seller'); // 👈 Mongoose model Seller

const router = express.Router();

// 🔒 Setup multer
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

// 🔑 ImageKit config
const imagekit = new ImageKit({
  publicKey: 'public_VCP7UXW5lvwXDkeSZdRukwnwTRE=',
  privateKey: 'private_bX2cSUtxrbNhR5ebUqFKESLanSA=',
  urlEndpoint: 'https://ik.imagekit.io/nyjh7ps82',
});

// 🌍 Wilayah API
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

// 🧾 POST /forum-pendaftaran/seller
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
    const existing = await Seller.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: '❌ Email sudah terdaftar sebagai seller' });
    }

    const folder = `/store-photos/${email.replace(/[@.]/g, '_')}`;
    const uploadResponse = await imagekit.upload({
      file: req.file.buffer,
      fileName: req.file.originalname,
      folder,
    });

    const seller = new Seller({
      email,
      name,
      businessName,
      phone,
      storeName,
      storeAddress,
      addressComponents: { kelurahan, kecamatan, kabupaten, provinsi },
      storeLocation: { type: 'Point', coordinates: [lng, lat] },
      storeImageUrl: uploadResponse.url,
      role: 'seller',
      createdAt: new Date(),
    });

    await seller.save();

    return res.status(201).json({
      message: '✅ Seller berhasil didaftarkan',
      imageUrl: uploadResponse.url,
      seller
    });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal simpan seller', error: error.message });
  }
});

module.exports = router;