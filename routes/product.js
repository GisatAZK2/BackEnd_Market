const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const ImageKit = require('imagekit');
const multer = require('multer');

const router = express.Router();
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // Maks 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('❌ Gambar harus berupa JPEG atau PNG'));
    }
  }
});

// Firebase init
if (!admin.apps.length) {
  const serviceAccount = require(path.join(__dirname, '../serviceAccountKey.json'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const usersCollection = db.collection('users');

// ImageKit init
const imagekit = new ImageKit({
  publicKey: 'public_VCP7UXW5lvwXDkeSZdRukwnwTRE=',
  privateKey: 'private_bX2cSUtxrbNhR5ebUqFKESLanSA=',
  urlEndpoint: 'https://ik.imagekit.io/nyjh7ps82',
});

// Helper untuk slugify nama produk jadi nama folder aman
const slugify = (str) =>
  str.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');

// 🔹 POST /product/upload
router.post('/upload', upload.single('productImage'), async (req, res) => {
  const {
    sellerId,
    productName,
    productDescription,
    productPrice
  } = req.body;

  // Validasi data
  if (!sellerId) return res.status(400).json({ message: '❌ sellerId wajib diisi' });
  if (!productName) return res.status(400).json({ message: '❌ Nama produk wajib diisi' });
  if (!productDescription) return res.status(400).json({ message: '❌ Deskripsi produk wajib diisi' });
  if (!productPrice) return res.status(400).json({ message: '❌ Harga produk wajib diisi' });

  const priceNum = parseFloat(productPrice);
  if (isNaN(priceNum) || priceNum <= 0) {
    return res.status(400).json({ message: '❌ Harga harus berupa angka lebih dari 0' });
  }

  if (!req.file) {
    return res.status(400).json({ message: '❌ Gambar produk wajib diunggah (JPEG/PNG maks 5MB)' });
  }

  try {
    // 🔍 Ambil data seller dari Firestore
    const sellerRef = usersCollection.doc(sellerId);
    const sellerDoc = await sellerRef.get();

    if (!sellerDoc.exists) {
      return res.status(404).json({ message: '❌ Seller tidak ditemukan' });
    }

    const sellerData = sellerDoc.data();
    const sellerEmail = sellerData.email || 'unknown@email.com';
    const sellerName = sellerData.name || 'Unknown Seller';

    // 🔁 Cek apakah produk dengan nama sama sudah ada
    const existingProducts = await sellerRef
      .collection('products')
      .where('productName', '==', productName)
      .limit(1)
      .get();

    if (!existingProducts.empty) {
      return res.status(409).json({ message: '❌ Nama produk sudah terdaftar oleh seller ini' });
    }

    // 🗂️ Buat folder unik per produk
    const productFolderName = slugify(productName);
    const productFolder = `/products/${sellerId}/${productFolderName}`;

    // ⬆️ Upload ke ImageKit
    const uploadResponse = await imagekit.upload({
      file: req.file.buffer,
      fileName: req.file.originalname,
      folder: productFolder,
    });

    // 🔖 Data produk
    const productData = {
      productName,
      productDescription,
      productPrice: priceNum,
      productImageUrl: uploadResponse.url,
      sellerId,
      sellerName,
      sellerEmail,
      createdAt: new Date()
    };

    await sellerRef.collection('products').add(productData);

    return res.status(201).json({ message: '✅ Produk berhasil diunggah', data: productData });
  } catch (error) {
    return res.status(500).json({
      message: '❌ Gagal unggah produk',
      error: error.message
    });
  }
});

module.exports = router;
