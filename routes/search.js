// routes/search.js
const express = require('express');
const { supabase } = require('../config/supabase');

const router = express.Router();

router.get('/search', async (req, res) => {
  const { q } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ message: '❌ Parameter "q" wajib diisi' });
  }

  try {
    const keyword = q.toLowerCase();
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .contains('keywords', [keyword]);

    if (error) throw error;

    res.status(200).json({
      message: `✅ Ditemukan ${products.length} produk`,
      products
    });
  } catch (error) {
    res.status(500).json({ message: '❌ Gagal mencari produk', error: error.message });
  }
});

module.exports = router;
