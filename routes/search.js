const express = require('express');
const supabase = require('../config/supabase');
const router = express.Router();

// ===== Helper ambil varian + stok total =====
async function attachVariantsAndStock(products) {
  return Promise.all(
    products.map(async (product) => {
      const { data: variants, error: variantErr } = await supabase
        .from('product_variants')
        .select('*')
        .eq('product_id', product.id);

      if (variantErr) throw variantErr;

      const totalStock = variants?.length
        ? variants.reduce((sum, v) => sum + (v.variant_stock || 0), 0)
        : product.stock;

      return {
        ...product,
        variants,
        total_stock: totalStock
      };
    })
  );
}

// ===== Search produk / seller =====
router.get('/', async (req, res) => {
  const { q, limit = 20, offset = 0 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ message: '❌ Parameter "q" wajib diisi' });
  }

  try {
    let keywords = q
      .split(/[,\s]+/)
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);
    keywords = [...new Set(keywords)];

    const { data: productResults, error: productErr } = await supabase
      .from('products')
      .select('*')
      .contains('keywords', keywords)
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (productErr) throw productErr;

    // fallback ke seller_name
    if (!productResults || productResults.length === 0) {
      const searchTerm = `%${q.toLowerCase()}%`;
      const { data: sellerResults, error: sellerErr } = await supabase
        .from('products')
        .select('seller_name')
        .ilike('seller_name', searchTerm);

      if (sellerErr) throw sellerErr;

      const sellers = [...new Set(sellerResults.map(p => p.seller_name))];
      return res.status(200).json({
        message: `✅ Tidak ada produk dengan kata kunci tersebut, tetapi ditemukan ${sellers.length} toko`,
        sellers,
      });
    }

    const productsWithVariants = await attachVariantsAndStock(productResults);

    res.status(200).json({
      message: `✅ Ditemukan ${productsWithVariants.length} produk`,
      keywords,
      products: productsWithVariants,
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    res.status(500).json({ message: '❌ Gagal mencari data', error: error.message });
  }
});

// ===== Meta =====
router.get('/meta', async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('id, product_name, seller_name, keywords');

    if (error) throw error;

    const keywords = [...new Set(products.flatMap(p => p.keywords))];
    const productNames = products.map(p => ({
      id: p.id,
      name: p.product_name,
      seller: p.seller_name,
    }));

    res.status(200).json({
      message: '✅ Data meta berhasil diambil',
      keywords,
      productNames,
    });
  } catch (error) {
    res.status(500).json({ message: '❌ Gagal mengambil data meta', error: error.message });
  }
});

// ===== Suggest =====
router.get('/suggest', async (req, res) => {
  const { q, limit = 10 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ message: '❌ Parameter "q" wajib diisi' });
  }

  try {
    const searchTerm = `%${q.toLowerCase()}%`;

    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .or(`product_name.ilike.${searchTerm},seller_name.ilike.${searchTerm}`)
      .limit(parseInt(limit));

    if (error) throw error;

    const keywordSet = new Set();
    products.forEach(p => {
      (p.keywords || [])
        .filter(k => k.toLowerCase().includes(q.toLowerCase()))
        .forEach(k => keywordSet.add(k));
    });

    const productsWithVariants = await attachVariantsAndStock(products);

    res.status(200).json({
      message: '✅ Suggestion ditemukan',
      keywords: [...keywordSet],
      products: productsWithVariants,
    });
  } catch (error) {
    res.status(500).json({ message: '❌ Gagal mengambil suggestion', error: error.message });
  }
});


// ===== All product =====
router.get('/allproduct', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    const productsWithVariants = await attachVariantsAndStock(products);

    return res.status(200).json({
      message: `✅ ${products.length} produk`,
      products: productsWithVariants,
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    return res.status(500).json({
      message: '❌ Gagal mengambil semua produk',
      error: error.message
    });
  }
});

module.exports = router;
