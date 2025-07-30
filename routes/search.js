const express = require('express');
const supabase = require('../config/supabase');

const router = express.Router();


router.get('/', async (req, res) => {
  const { q } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ message: '❌ Parameter "q" wajib diisi' });
  }

  try {
    let keywords = q
      .split(/[,\s]+/)
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);

    // Hapus duplikat keywords
    keywords = [...new Set(keywords)];

    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .contains('keywords', keywords);

    if (error) throw error;

    res.status(200).json({
      message: `✅ Ditemukan ${products.length} produk`,
      keywords,
      products,
    });
  } catch (error) {
    res.status(500).json({
      message: '❌ Gagal mencari produk',
      error: error.message,
    });
  }
});

/**
 * Ambil data meta (semua keywords unik + nama produk)
 * Contoh: /search/meta
 */
router.get('/meta', async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('id, product_name, keywords');

    if (error) throw error;

    const keywords = [...new Set(products.flatMap(p => p.keywords))];
    const productNames = products.map(p => ({
      id: p.id,
      name: p.product_name,
    }));

    res.status(200).json({
      message: '✅ Data meta berhasil diambil',
      keywords,
      productNames,
    });
  } catch (error) {
    res.status(500).json({
      message: '❌ Gagal mengambil data meta',
      error: error.message,
    });
  }
});

/**
 * Suggestion by partial keyword
 * Contoh: /search/suggest?q=nas
 */
router.get('/suggest', async (req, res) => {
  const { q } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ message: '❌ Parameter "q" wajib diisi' });
  }

  try {
    const searchTerm = `%${q.toLowerCase()}%`;

    // Cari produk berdasarkan nama (ilike) + keywords mengandung q
    const { data: products, error } = await supabase
      .from('products')
      .select('product_name, keywords')
      .or(`product_name.ilike.${searchTerm}`)
      .limit(10);

    if (error) throw error;

    // Filter keywords yang mengandung q
    const keywordSet = new Set();
    products.forEach(p => {
      (p.keywords || [])
        .filter(k => k.toLowerCase().includes(q.toLowerCase()))
        .forEach(k => keywordSet.add(k));
    });

    res.status(200).json({
      message: '✅ Suggestion ditemukan',
      keywords: [...keywordSet],
      productNames: products.map(p => p.product_name),
    });
  } catch (error) {
    res.status(500).json({
      message: '❌ Gagal mengambil suggestion',
      error: error.message,
    });
  }
});

module.exports = router;
