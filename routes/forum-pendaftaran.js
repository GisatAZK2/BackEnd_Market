const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const ImageKit = require('imagekit');
const multer = require('multer');
const fetch = require('node-fetch');

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

// 🔒 Inisialisasi Firebase
if (!admin.apps.length) {
  const serviceAccount = require(path.join(__dirname, './serviceAccountKey.json'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const usersCollection = db.collection('users');

// 🔑 ImageKit config
const imagekit = new ImageKit({
  publicKey: 'public_VCP7UXW5lvwXDkeSZdRukwnwTRE=',
  privateKey: 'private_bX2cSUtxrbNhR5ebUqFKESLanSA=',
  urlEndpoint: 'https://ik.imagekit.io/nyjh7ps82',
});

// 🔹 GET /wilayah/provinsi
router.get('/wilayah/provinsi', async (req, res) => {
  try {
    const response = await fetch('https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json');
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: '❌ Gagal ambil data provinsi', error: err.message });
  }
});

// 🔹 GET /wilayah/kabupaten/:provinsiId
router.get('/wilayah/kabupaten/:provinsiId', async (req, res) => {
  const { provinsiId } = req.params;
  try {
    const response = await fetch(`https://www.emsifa.com/api-wilayah-indonesia/api/regencies/${provinsiId}.json`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: '❌ Gagal ambil data kabupaten', error: err.message });
  }
});

// 🔹 GET /wilayah/kecamatan/:kabupatenId
router.get('/wilayah/kecamatan/:kabupatenId', async (req, res) => {
  const { kabupatenId } = req.params;
  try {
    const response = await fetch(`https://www.emsifa.com/api-wilayah-indonesia/api/districts/${kabupatenId}.json`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: '❌ Gagal ambil data kecamatan', error: err.message });
  }
});

// 🔹 GET /wilayah/kelurahan/:kecamatanId
router.get('/wilayah/kelurahan/:kecamatanId', async (req, res) => {
  const { kecamatanId } = req.params;
  try {
    const response = await fetch(`https://www.emsifa.com/api-wilayah-indonesia/api/villages/${kecamatanId}.json`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: '❌ Gagal ambil data kelurahan', error: err.message });
  }
});

// 🔹 POST /forum-pendaftaran/seller
router.post('/seller', upload.single('storeImage'), async (req, res) => {
  const {
    email,
    name,
    businessName,
    phone,
    storeName,
    storeAddress,
    kelurahan,
    kecamatan,
    kabupaten,
    provinsi,
    latitude,
    longitude
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
    const existing = await usersCollection.where('email', '==', email).limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ message: '❌ Email sudah terdaftar sebagai seller' });
    }

    const folder = `/store-photos/${email.replace(/[@.]/g, '_')}`;
    const uploadResponse = await imagekit.upload({
      file: req.file.buffer,
      fileName: req.file.originalname,
      folder,
    });

    const sellerData = {
      email,
      name,
      businessName,
      phone,
      storeName,
      storeAddress,
      addressComponents: {
        kelurahan,
        kecamatan,
        kabupaten,
        provinsi
      },
      storeLocation: new admin.firestore.GeoPoint(lat, lng),
      storeImageUrl: uploadResponse.url,
      role: 'seller',
      createdAt: new Date(),
    };

    await usersCollection.add(sellerData);

    return res.status(201).json({
      message: '✅ Seller berhasil didaftarkan',
      imageUrl: uploadResponse.url,
      seller: sellerData
    });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal simpan seller', error: error.message });
  }
});

module.exports = router;
