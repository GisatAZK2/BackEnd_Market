// routes/sellerWithProducts.js
const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const {
  attachVariantsStockDiscountWithRealDiscount,
} = require("../utils/applyDiscountAndVariants");
const { DateTime } = require("luxon");
const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 10 });

router.get("/allseller", async (req, res) => {
  const cached = cache.get("all_sellers_with_products");
  if (cached) {
    return res.status(200).json({
      message: `✅ ${cached.length} seller berhasil diambil (cache)`,
      data: cached,
    });
  }

  try {
    const { data, error } = await supabase.from("sellers").select(`
        *,
        products (*)
      `);

    if (error) {
      return res.status(500).json({
        message: "❌ Gagal mengambil data seller",
        error: error.message,
      });
    }

    // Flatten semua produk
    const allProducts = data.flatMap((seller) => seller.products);

    // Proses varian & diskon sekali
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(allProducts);

    // Buat map produk per seller_id biar akses O(1)
    const productMap = new Map();
    for (const product of productsWithVariants) {
      if (!productMap.has(product.seller_id)) {
        productMap.set(product.seller_id, []);
      }
      productMap.get(product.seller_id).push(product);
    }

    // Gabungkan ke seller
    const sellersWithProducts = data.map((seller) => ({
      seller: { ...seller, products: undefined }, // hapus field bawaan
      products: productMap.get(seller.id) || [],
    }));

    cache.set("all_sellers_with_products", sellersWithProducts, 30);

    return res.status(200).json({
      message: `✅ ${sellersWithProducts.length} seller berhasil diambil`,
      data: sellersWithProducts,
    });
  } catch (err) {
    return res.status(500).json({
      message: "❌ Terjadi kesalahan saat mengambil data",
      error: err.message,
    });
  }
});

// GET Seller beserta produk-produknya
router.get("/:id", async (req, res) => {
  const sellerId = req.params.id;

  const cached = cache.get(`seller_${sellerId}`);
  if (cached) {
    return res.status(200).json({
      message: `✅ Seller & ${cached.products.length} produk berhasil diambil (cache)`,
      ...cached,
    });
  }

  try {
    const { data: seller, error: sellerError } = await supabase
      .from("sellers")
      .select("*")
      .eq("id", sellerId)
      .single();

    if (sellerError || !seller) {
      return res.status(404).json({ message: "❌ Seller tidak ditemukan" });
    }

    const { data: products, error: productError } = await supabase
      .from("products")
      .select("*")
      .eq("seller_id", sellerId);

    if (productError) {
      return res.status(500).json({
        message: "❌ Gagal mengambil produk seller",
        error: productError.message,
      });
    }

    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(products);
    const result = { seller, products: productsWithVariants };

    cache.set(`seller_${sellerId}`, result);
    return res.status(200).json({
      message: `✅ Seller & ${productsWithVariants.length} produk berhasil diambil`,
      ...result,
    });
  } catch (err) {
    return res.status(500).json({
      message: "❌ Gagal mengambil data seller beserta produk",
      error: err.message,
    });
  }
});
// ✅ Get rating semua produk seller + average
router.get("/:sellerId/ratings", async (req, res) => {
  try {
    const { sellerId } = req.params;

    // Ambil semua rating + join ke produk seller
    const { data: ratings, error } = await supabase
      .from("ratings")
      .select(
        `
        id,
        rating,
        review_text,
        review_images,
        created_at,
        product_id,
        user_id,
        users ( id, username, avatar ),
        products!inner ( id, product_name, seller_id )
        `
      )
      .eq("products.seller_id", sellerId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ message: "❌ Gagal ambil rating seller." });
    }

    if (!ratings || ratings.length === 0) {
      return res.status(200).json({
        message: "⚠️ Seller ini belum punya rating.",
        average_rating: 0,
        total_reviews: 0,
        ratings: [],
      });
    }

    const total = ratings.reduce((sum, r) => sum + r.rating, 0);
    const avg = total / ratings.length;

    return res.status(200).json({
      message: "✅ Rating seller berhasil diambil.",
      average_rating: Number(avg.toFixed(2)),
      total_reviews: ratings.length,
      ratings,
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});


module.exports = router;
