const express = require("express");
const supabase = require("../config/supabase");
const router = express.Router();
const {
  attachVariantsStockDiscountWithRealDiscount,
} = require("../utils/applyDiscountAndVariants");

// ===============================
// 🔍 Search Produk by Keyword
// ===============================
router.get("/", async (req, res) => {
  const { q, limit = 20, offset = 0 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ message: '❌ Parameter "q" wajib diisi' });
  }

  try {
    let keywords = q
      .split(/[,\s]+/)
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    keywords = [...new Set(keywords)];

    const { data: productResults, error: productErr } = await supabase
      .from("products")
      .select("*")
      .contains("keywords", keywords)
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (productErr) throw productErr;

    if (!productResults || productResults.length === 0) {
      return res.status(200).json({
        message: "❌ Tidak ditemukan produk dengan kata kunci tersebut",
        products: [],
      });
    }

    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(productResults);

    res.status(200).json({
      message: `✅ Ditemukan ${productsWithVariants.length} produk`,
      keywords,
      products: productsWithVariants,
      pagination: { limit: parseInt(limit), offset: parseInt(offset) },
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "❌ Gagal mencari data produk", error: error.message });
  }
});

// ===============================
// 🧑 Search Toko (seller_name)
// ===============================
// routes/seller.js
router.get("/seller", async (req, res) => {
  const { q, limit = 20, offset = 0 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ message: '❌ Parameter "q" wajib diisi' });
  }

  try {
    const searchTerm = `%${q.toLowerCase()}%`;

    const { data: sellers, error } = await supabase
      .from("sellers")
      .select("*")
      .ilike("store_name", searchTerm)
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    return res.status(200).json({
      message: `✅ Ditemukan ${sellers.length} seller`,
      sellers,
      pagination: { limit: parseInt(limit), offset: parseInt(offset) },
    });
  } catch (error) {
    return res.status(500).json({
      message: "❌ Gagal mencari seller",
      error: error.message,
    });
  }
});

// ===============================
// 🧠 Meta Produk (nama / keyword / varian)
// ===============================
router.get("/meta", async (req, res) => {
  try {
    const q = req.query.q || "";

    const { data: mainProducts, error: mainError } = await supabase
      .from("products")
      .select("*")
      .or(`product_name.ilike.%${q}%,keywords.cs.{${q}}`);

    if (mainError) throw mainError;

    const { data: variantProducts, error: variantError } = await supabase
      .from("product_variants")
      .select("product_id, variant_name")
      .ilike("variant_name", `%${q}%`);

    if (variantError) throw variantError;

    const variantProductIds = [
      ...new Set(variantProducts.map((v) => v.product_id)),
    ];

    let additionalProducts = [];
    if (variantProductIds.length > 0) {
      const mainProductIds = mainProducts.map((p) => p.id);
      const missingProductIds = variantProductIds.filter(
        (id) => !mainProductIds.includes(id),
      );

      if (missingProductIds.length > 0) {
        const { data: missingProducts, error: missingError } = await supabase
          .from("products")
          .select("*")
          .in("id", missingProductIds);

        if (missingError) throw missingError;
        additionalProducts = missingProducts;
      }
    }

    const products = [...mainProducts, ...additionalProducts];
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(products);

    return res.status(200).json({
      message: `✅ ${productsWithVariants.length} produk ditemukan`,
      products: productsWithVariants,
    });
  } catch (error) {
    return res.status(500).json({
      message: "❌ Gagal mencari produk meta",
      error: error.message,
    });
  }
});

// ===============================
// 💡 Keyword Suggestion
// ===============================
router.get("/suggest", async (req, res) => {
  const { q, limit = 10 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ message: '❌ Parameter "q" wajib diisi' });
  }

  try {
    const searchTerm = `%${q.toLowerCase()}%`;

    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .or(`product_name.ilike.${searchTerm},seller_name.ilike.${searchTerm}`)
      .limit(parseInt(limit));

    if (error) throw error;

    const keywordSet = new Set();
    products.forEach((p) => {
      (p.keywords || [])
        .filter((k) => k.toLowerCase().includes(q.toLowerCase()))
        .forEach((k) => keywordSet.add(k));
    });

    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(products);

    res.status(200).json({
      message: "✅ Suggestion ditemukan",
      keywords: [...keywordSet],
      products: productsWithVariants,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "❌ Gagal mengambil suggestion", error: error.message });
  }
});

// ===============================
// 📦 Get All Produk (Paginated)
// ===============================
router.get("/allproduct", async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(products);

    return res.status(200).json({
      message: `✅ ${products.length} produk`,
      products: productsWithVariants,
      pagination: { limit: parseInt(limit), offset: parseInt(offset) },
    });
  } catch (error) {
    return res.status(500).json({
      message: "❌ Gagal mengambil semua produk",
      error: error.message,
    });
  }
});

module.exports = router;
