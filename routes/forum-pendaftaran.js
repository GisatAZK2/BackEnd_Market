const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const ImageKit = require('imagekit');
const multer = require('multer');

const router = express.Router();

// 🔒 Setup multer untuk validasi gambar
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('❌ Gambar harus berupa JPEG atau PNG'));
    }
  }
});

// 🔒 Inisialisasi Firebase (jika belum)
if (!admin.apps.length) {
  const serviceAccount = require(path.join(__dirname, '../serviceAccountKey.json'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const usersCollection = db.collection('users');

// 🔑 ImageKit setup
const imagekit = new ImageKit({
  publicKey: 'public_VCP7UXW5lvwXDkeSZdRukwnwTRE=',
  privateKey: 'private_bX2cSUtxrbNhR5ebUqFKESLanSA=',
  urlEndpoint: 'https://ik.imagekit.io/nyjh7ps82',
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
    addressComponents,
    latitude,
    longitude
  } = req.body;

  // ✅ Validasi isi
  if (!email) return res.status(400).json({ message: '❌ Email wajib diisi' });
  if (!name) return res.status(400).json({ message: '❌ Nama wajib diisi' });
  if (!businessName) return res.status(400).json({ message: '❌ Nama bisnis wajib diisi' });
  if (!phone) return res.status(400).json({ message: '❌ Nomor telepon wajib diisi' });
  if (!storeName) return res.status(400).json({ message: '❌ Nama toko wajib diisi' });
  if (!storeAddress) return res.status(400).json({ message: '❌ Alamat toko wajib diisi' });
  if (!latitude || !longitude) return res.status(400).json({ message: '❌ Lokasi toko (latitude & longitude) wajib diisi' });
  if (!req.file) return res.status(400).json({ message: '❌ Gambar toko wajib diunggah (JPEG/PNG maks 5MB)' });

  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);
  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ message: '❌ Latitude dan longitude harus berupa angka valid' });
  }

  try {
    // 🔁 Cek apakah email sudah terdaftar
    const existing = await usersCollection.where('email', '==', email).limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ message: '❌ Email sudah terdaftar sebagai seller' });
    }

    // 📁 Buat folder ImageKit aman berdasarkan email
    const sellerFolder = `/store-photos/${email.replace(/[@.]/g, '_')}`;

    // ⬆️ Upload gambar ke ImageKit
    const uploadResponse = await imagekit.upload({
      file: req.file.buffer,
      fileName: req.file.originalname,
      folder: sellerFolder,
    });

    // 🔖 Siapkan data untuk Firestore
    const sellerData = {
      email,
      name,
      businessName,
      phone,
      storeName,
      storeAddress,
      addressComponents: addressComponents ? JSON.parse(addressComponents) : {},
      storeLocation: new admin.firestore.GeoPoint(lat, lon),
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
    return res.status(500).json({ message: '❌ Gagal simpan seller atau upload gambar', error: error.message });
  }
});

module.exports = router;
