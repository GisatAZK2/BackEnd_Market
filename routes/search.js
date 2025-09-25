const express = require("express");
const supabase = require("../config/supabase");
const router = express.Router();
const {
  attachVariantsStockDiscountWithRealDiscount,
} = require("../utils/applyDiscountAndVariants");

// Helper function to get unified seller name
const getUnifiedSellerName = (seller) => {
  return seller.store_name || seller.name || seller.business_name || "Unknown Seller";
};

// Helper function to attach ratings and followers
const attachRatingsAndFollowers = async (sellers) => {
  // Get ratings
  const { data: ratings, error: ratingError } = await supabase
    .from("ratings")
    .select(`id, rating, product_id, products!inner(id, seller_id)`);

  if (ratingError) throw ratingError;

  const ratingMap = new Map();
  for (const r of ratings) {
    const sid = r.products.seller_id;
    if (!ratingMap.has(sid)) ratingMap.set(sid, []);
    ratingMap.get(sid).push(r.rating);
  }

  // Get followers
  const { data: followers, error: followerError } = await supabase
    .from("follows")
    .select("seller_id");

  if (followerError) throw followerError;

  const followerMap = new Map();
  for (const f of followers) {
    const sid = f.seller_id;
    followerMap.set(sid, (followerMap.get(sid) || 0) + 1);
  }

  return { ratingMap, followerMap };
};

// ===============================
// 🔍 Search Produk by Keyword or Seller Name
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
    const searchTerm = `%${q.toLowerCase()}%`;

    // Search products by keywords or seller name
    const { data: productResults, error: productErr } = await supabase
      .from("products")
      .select(`
        *,
        sellers!inner(id, store_name, name, business_name)
      `)
      .or(`keywords.cs.{${keywords.join(',')}},seller_name.ilike.${searchTerm}`)
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (productErr) throw productErr;

    if (!productResults || productResults.length === 0) {
      return res.status(200).json({
        message: "❌ Tidak ditemukan produk dengan kata kunci tersebut",
        products: [],
      });
    }

    const productsWithVariants = await attachVariantsStockDiscountWithRealDiscount(productResults);

    // Attach ratings and followers
    const { ratingMap, followerMap } = await attachRatingsAndFollowers(productResults.map(p => p.sellers));

    const enhancedProducts = productsWithVariants.map(product => {
      const sellerRatings = ratingMap.get(product.seller_id) || [];
      const avgRating = sellerRatings.length > 0
        ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(2)
        : "0.00";
      const totalFollowers = followerMap.get(product.seller_id) || 0;

      return {
        ...product,
        seller_name: getUnifiedSellerName(product.sellers),
        average_rating: avgRating,
        total_reviews: sellerRatings.length,
        total_followers: totalFollowers,
        sellers: undefined // Remove raw sellers data
      };
    });

    res.status(200).json({
      message: `✅ Ditemukan ${enhancedProducts.length} produk`,
      keywords,
      products: enhancedProducts,
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
router.get("/seller", async (req, res) => {
  const { q, limit = 20, offset = 0 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ message: '❌ Parameter "q" wajib diisi' });
  }

  try {
    const searchTerm = `%${q.toLowerCase()}%`;

    // Search sellers by store_name, name, or business_name
    const { data: sellers, error: sellerError } = await supabase
      .from("sellers")
      .select("*")
      .or(`store_name.ilike.${searchTerm},name.ilike.${searchTerm},business_name.ilike.${searchTerm}`)
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (sellerError) throw sellerError;

    if (!sellers || sellers.length === 0) {
      return res.status(200).json({
        message: "✅ Tidak ada seller ditemukan",
        sellers: [],
        pagination: { limit: parseInt(limit), offset: parseInt(offset) },
      });
    }

    // Attach ratings and followers
    const { ratingMap, followerMap } = await attachRatingsAndFollowers(sellers);

    // Get products for found sellers
    const sellerIds = sellers.map((s) => s.id);
    const { data: products, error: productError } = await supabase
      .from("products")
      .select("*")
      .in("seller_id", sellerIds);

    if (productError) throw productError;

    const productsWithVariants = await attachVariantsStockDiscountWithRealDiscount(products);

    // Group products by seller_id
    const productMap = new Map();
    for (const product of productsWithVariants) {
      if (!productMap.has(product.seller_id)) {
        productMap.set(product.seller_id, []);
      }
      productMap.get(product.seller_id).push(product);
    }

    // Combine sellers with their products and metrics
    const sellersWithProducts = sellers.map((seller) => {
      const sellerRatings = ratingMap.get(seller.id) || [];
      const avgRating = sellerRatings.length > 0
        ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(2)
        : "0.00";
      const totalFollowers = followerMap.get(seller.id) || 0;
      const totalSold = (productMap.get(seller.id) || []).reduce((acc, p) => acc + (p.sold_count || 0), 0);

      // Sort products: by sold_count desc, then by rating desc
      let products = productMap.get(seller.id) || [];
      products = products.sort((a, b) => {
        if ((b.sold_count || 0) !== (a.sold_count || 0)) {
          return (b.sold_count || 0) - (a.sold_count || 0);
        }
        return (b.average_rating || 0) - (a.average_rating || 0);
      }).slice(0, 3); // Take top 3

      return {
        ...seller,
        seller_name: getUnifiedSellerName(seller),
        products,
        average_rating: avgRating,
        total_reviews: sellerRatings.length,
        total_followers: totalFollowers,
        total_sold: totalSold,
      };
    });

    return res.status(200).json({
      message: `✅ Ditemukan ${sellers.length} seller beserta 3 produk terbaik`,
      sellers: sellersWithProducts,
      pagination: { limit: parseInt(limit), offset: parseInt(offset) },
    });
  } catch (error) {
    return res.status(500).json({
      message: "❌ Gagal mencari seller beserta produk",
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
    const searchTerm = `%${q}%`;

    const { data: mainProducts, error: mainError } = await supabase
      .from("products")
      .select(`
        *,
        sellers!inner(id, store_name, name, business_name)
      `)
      .or(`product_name.ilike.${searchTerm},keywords.cs.{${q}},seller_name.ilike.${searchTerm}`);

    if (mainError) throw mainError;

    const { data: variantProducts, error: variantError } = await supabase
      .from("product_variants")
      .select("product_id, variant_name")
      .ilike("variant_name", `%${q}%`);

    if (variantError) throw variantError;

    const variantProductIds = [...new Set(variantProducts.map((v) => v.product_id))];
    let additionalProducts = [];
    if (variantProductIds.length > 0) {
      const mainProductIds = mainProducts.map((p) => p.id);
      const missingProductIds = variantProductIds.filter(
        (id) => !mainProductIds.includes(id),
      );

      if (missingProductIds.length > 0) {
        const { data: missingProducts, error: missingError } = await supabase
          .from("products")
          .select(`
            *,
            sellers!inner(id, store_name, name, business_name)
          `)
          .in("id", missingProductIds);

        if (missingError) throw missingError;
        additionalProducts = missingProducts;
      }
    }

    const products = [...mainProducts, ...additionalProducts];
    const productsWithVariants = await attachVariantsStockDiscountWithRealDiscount(products);

    // Attach ratings and followers
    const { ratingMap, followerMap } = await attachRatingsAndFollowers(products.map(p => p.sellers));

    const enhancedProducts = productsWithVariants.map(product => {
      const sellerRatings = ratingMap.get(product.seller_id) || [];
      const avgRating = sellerRatings.length > 0
        ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(2)
        : "0.00";
      const totalFollowers = followerMap.get(product.seller_id) || 0;

      return {
        ...product,
        seller_name: getUnifiedSellerName(product.sellers),
        average_rating: avgRating,
        total_reviews: sellerRatings.length,
        total_followers: totalFollowers,
        sellers: undefined // Remove raw sellers data
      };
    });

    return res.status(200).json({
      message: `✅ ${enhancedProducts.length} produk ditemukan`,
      products: enhancedProducts,
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
      .select(`
        *,
        sellers!inner(id, store_name, name, business_name)
      `)
      .or(`product_name.ilike.${searchTerm},seller_name.ilike.${searchTerm}`)
      .limit(parseInt(limit));

    if (error) throw error;

    const keywordSet = new Set();
    products.forEach((p) => {
      (p.keywords || [])
        .filter((k) => k.toLowerCase().includes(q.toLowerCase()))
        .forEach((k) => keywordSet.add(k));
    });

    const productsWithVariants = await attachVariantsStockDiscountWithRealDiscount(products);

    // Attach ratings and followers
    const { ratingMap, followerMap } = await attachRatingsAndFollowers(products.map(p => p.sellers));

    const enhancedProducts = productsWithVariants.map(product => {
      const sellerRatings = ratingMap.get(product.seller_id) || [];
      const avgRating = sellerRatings.length > 0
        ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(2)
        : "0.00";
      const totalFollowers = followerMap.get(product.seller_id) || 0;

      return {
        ...product,
        seller_name: getUnifiedSellerName(product.sellers),
        average_rating: avgRating,
        total_reviews: sellerRatings.length,
        total_followers: totalFollowers,
        sellers: undefined // Remove raw sellers data
      };
    });

    res.status(200).json({
      message: "✅ Suggestion ditemukan",
      keywords: [...keywordSet],
      products: enhancedProducts,
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
      .select(`
        *,
        sellers!inner(id, store_name, name, business_name)
      `)
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    const productsWithVariants = await attachVariantsStockDiscountWithRealDiscount(products);

    // Attach ratings and followers
    const { ratingMap, followerMap } = await attachRatingsAndFollowers(products.map(p => p.sellers));

    const enhancedProducts = productsWithVariants.map(product => {
      const sellerRatings = ratingMap.get(product.seller_id) || [];
      const avgRating = sellerRatings.length > 0
        ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(2)
        : "0.00";
      const totalFollowers = followerMap.get(product.seller_id) || 0;

      return {
        ...product,
        seller_name: getUnifiedSellerName(product.sellers),
        average_rating: avgRating,
        total_reviews: sellerRatings.length,
        total_followers: totalFollowers,
        sellers: undefined // Remove raw sellers data
      };
    });

    return res.status(200).json({
      message: `✅ ${products.length} produk`,
      products: enhancedProducts,
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