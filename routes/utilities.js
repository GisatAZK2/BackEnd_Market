const express = require('express');
const admin = require('firebase-admin');
const path = require('path');

const router = express.Router();


// 🔎 Saran keyword produk
router.get('/search-suggestions', async (req, res) => {
  const { keyword } = req.query;

  if (!keyword || keyword.trim() === '') {
    return res.status(400).json({ message: '❌ Keyword pencarian wajib diisi' });
  }

  const searchLower = keyword.toLowerCase();
  const suggestions = new Set();

  try {
    const sellersSnap = await usersCollection.where('role', '==', 'seller').get();

    for (const sellerDoc of sellersSnap.docs) {
      const productSnap = await usersCollection
        .doc(sellerDoc.id)
        .collection('products')
        .get();

      productSnap.forEach((doc) => {
        const data = doc.data();
        const name = data.productName || '';
        if (name.toLowerCase().includes(searchLower)) {
          suggestions.add(name); // hanya nama produk, disimpan unik
        }
      });
    }

    return res.status(200).json({
      message: `✅ Ditemukan ${suggestions.size} saran keyword`,
      suggestions: Array.from(suggestions)
    });
  } catch (error) {
    return res.status(500).json({
      message: '❌ Gagal mencari saran keyword',
      error: error.message
    });
  }
});


// 🔎 Search produk berdasarkan keyword (nama)
router.get('/search', async (req, res) => {
  const { keyword } = req.query;

  if (!keyword || keyword.trim() === '') {
    return res.status(400).json({ message: '❌ Keyword pencarian wajib diisi' });
  }

  const searchLower = keyword.toLowerCase();
  const matchedProducts = [];
  const seenIds = new Set();

  try {
    const sellersSnap = await usersCollection.where('role', '==', 'seller').get();

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
        const nameLower = (data.productName || '').toLowerCase();

        if (nameLower.includes(searchLower)) {
          matchedProducts.push({
            id: doc.id,
            sellerId: sellerDoc.id,
            sellerName: sellerData.storeName || sellerData.name,
            sellerLocation: sellerData.storeLocation || null,
            ...data,
          });
        }
      });
    }

    return res.status(200).json({
      message: `✅ Ditemukan ${matchedProducts.length} produk dengan kata kunci "${keyword}"`,
      products: matchedProducts
    });
  } catch (error) {
    return res.status(500).json({
      message: '❌ Gagal mencari produk',
      error: error.message
    });
  }
});

module.exports = router;
