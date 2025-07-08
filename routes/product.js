const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const ImageKit = require('imagekit');
const multer = require('multer');

const router = express.Router();

// 🔒 Setup multer
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('❌ Gambar harus berupa JPEG atau PNG'));
    }
  }
});

// 🔐 Firebase init
if (!admin.apps.length) {
  const serviceAccount = require(path.join(__dirname, '../serviceAccountKey.json'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const usersCollection = db.collection('users');

// 🔑 ImageKit init
const imagekit = new ImageKit({
  publicKey: 'public_VCP7UXW5lvwXDkeSZdRukwnwTRE=',
  privateKey: 'private_bX2cSUtxrbNhR5ebUqFKESLanSA=',
  urlEndpoint: 'https://ik.imagekit.io/nyjh7ps82',
});

// Helper slugify
const slugify = (str) =>
  str.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');

// 🔹 Upload produk
router.post('/upload', upload.single('productImage'), async (req, res) => {
  const {
    sellerId,
    productName,
    productDescription,
    productPrice
  } = req.body;

  if (!sellerId || !productName || !productDescription || !productPrice) {
    return res.status(400).json({ message: '❌ Semua field wajib diisi' });
  }

  const priceNum = parseFloat(productPrice);
  if (isNaN(priceNum) || priceNum <= 0) {
    return res.status(400).json({ message: '❌ Harga harus berupa angka lebih dari 0' });
  }

  if (!req.file) {
    return res.status(400).json({ message: '❌ Gambar produk wajib diunggah' });
  }

  try {
    const sellerRef = usersCollection.doc(sellerId);
    const sellerDoc = await sellerRef.get();

    if (!sellerDoc.exists) {
      return res.status(404).json({ message: '❌ Seller tidak ditemukan' });
    }

    const sellerData = sellerDoc.data();
    const sellerEmail = sellerData.email || 'unknown@email.com';
    const sellerName = sellerData.name || 'Unknown Seller';

    const existingProducts = await sellerRef
      .collection('products')
      .where('productName', '==', productName)
      .limit(1)
      .get();

    if (!existingProducts.empty) {
      return res.status(409).json({ message: '❌ Nama produk sudah terdaftar oleh seller ini' });
    }

    const productFolder = `/products/${sellerId}/${slugify(productName)}`;
    const uploadResponse = await imagekit.upload({
      file: req.file.buffer,
      fileName: req.file.originalname,
      folder: productFolder,
    });

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

// 🔍 Haversine untuk jarak
const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// 🔁 Cache produk mentah
let rawProductsCache = null;
let lastCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 60 detik

// 🔹 Produk terdekat
router.get('/nearby-by-location', async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ message: '❌ lat dan lng wajib diisi di query parameter' });
  }

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  if (isNaN(userLat) || isNaN(userLng)) {
    return res.status(400).json({ message: '❌ Koordinat tidak valid' });
  }

  try {
    // Ambil cache jika tidak valid
    if (!rawProductsCache || Date.now() - lastCacheTime > CACHE_TTL) {
      rawProductsCache = [];
      const seenIds = new Set();

      const sellersSnap = await usersCollection.where('role', '==', 'seller').get();

      for (const sellerDoc of sellersSnap.docs) {
        const sellerData = sellerDoc.data();
        const sellerLocation = sellerData.storeLocation;
        if (!sellerLocation) continue;

        const productSnap = await usersCollection
          .doc(sellerDoc.id)
          .collection('products')
          .get();

        productSnap.forEach((doc) => {
          if (seenIds.has(doc.id)) return; // ❌ Skip duplikat
          seenIds.add(doc.id);

          const data = doc.data();
          rawProductsCache.push({
            id: doc.id,
            sellerId: sellerDoc.id,
            sellerName: sellerData.storeName || sellerData.name,
            sellerLocation,
            ...data
          });
        });
      }

      lastCacheTime = Date.now();
    }

    const nearbyProducts = rawProductsCache
      .map((product) => {
        const { sellerLocation } = product;
        const distance = haversineDistance(
          userLat,
          userLng,
          sellerLocation.latitude,
          sellerLocation.longitude
        );
        return {
          ...product,
          distanceInKm: +distance.toFixed(2)
        };
      })
      .filter((p) => p.distanceInKm <= 40);

    return res.status(200).json({
      message: `✅ Ditemukan ${nearbyProducts.length} produk dalam radius 40 km`,
      products: nearbyProducts
    });
  } catch (error) {
    return res.status(500).json({
      message: '❌ Gagal mengambil produk berdasarkan lokasi',
      error: error.message
    });
  }
});

// 🔹 Semua produk (tanpa lokasi) + filter duplikat
router.get('/allproduct', async (req, res) => {
  try {
    const sellersSnap = await usersCollection.where('role', '==', 'seller').get();

    const allProducts = [];
    const seenIds = new Set();

    for (const sellerDoc of sellersSnap.docs) {
      const sellerData = sellerDoc.data();

      const productSnap = await usersCollection
        .doc(sellerDoc.id)
        .collection('products')
        .get();

      productSnap.forEach((doc) => {
        if (seenIds.has(doc.id)) return;
        seenIds.add(doc.id);

        const data = doc.data();
        allProducts.push({
          id: doc.id,
          sellerId: sellerDoc.id,
          sellerName: sellerData.storeName || sellerData.name,
          sellerLocation: sellerData.storeLocation || null,
          ...data,
        });
      });
    }

    return res.status(200).json({
      message: `✅ Ditemukan ${allProducts.length} produk`,
      products: allProducts
    });
  } catch (error) {
    return res.status(500).json({
      message: '❌ Gagal mengambil semua produk',
      error: error.message
    });
  }
});

module.exports = router;
