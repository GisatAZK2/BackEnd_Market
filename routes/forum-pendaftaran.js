const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const path = require('path');

// Inisialisasi Firebase (jika belum)
if (!admin.apps.length) {
  const serviceAccount = require(path.join(__dirname, '../serviceAccountKey.json'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const usersCollection = db.collection('users');

// 🔹 Endpoint untuk Buyer: /forum-pendaftaran/buyer
router.post('/buyer', async (req, res) => {
  const { email, name } = req.body;

  if (!email || !name) {
    return res.status(400).json({ message: 'Data wajib: email dan name' });
  }

  try {
    await usersCollection.add({ email, name, role: 'buyer', createdAt: new Date() });
    return res.json({ message: 'Buyer registered and saved to Firestore', status: 'buyer' });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal simpan buyer', error: error.message });
  }
});

// 🔹 Endpoint untuk Seller: /forum-pendaftaran/seller
router.post('/seller', async (req, res) => {
  const { email, name, businessName, phone } = req.body;

  if (!email || !name || !businessName || !phone) {
    return res.status(400).json({ message: 'Data wajib untuk seller: email, name, businessName, phone' });
  }

  try {
    await usersCollection.add({ email, name, businessName, phone, role: 'seller', createdAt: new Date() });
    return res.json({ message: 'Seller registered and saved to Firestore', status: 'seller' });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal simpan seller', error: error.message });
  }
});

module.exports = router;
