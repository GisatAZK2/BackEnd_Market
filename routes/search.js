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
const attachRatingsAndFollowers = async () => {
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

// Helper function to get total sold (terjual) from products table
const calculateTotalSold = async (productIds) => {
  if (!productIds || productIds.length === 0) return new Map();

  const { data: products, error: productError } = await supabase
    .from("products")
    .select("id, terjual")
    .in("id", productIds);

  if (productError) throw productError;

  const soldMap = new Map();
  for (const product of products) {
    soldMap.set(product.id, product.terjual || 0);
  }

  return soldMap;
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
        sellers!inner(id, store_name, name, business_name, is_delivery_available, delivery_fee),
        ratings!left(rating)
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

    // Calculate total sold for each product
    const productIds = productsWithVariants.map(p => p.id);
    const soldMap = await calculateTotalSold(productIds);

    // Attach ratings and followers
    const { ratingMap, followerMap } = await attachRatingsAndFollowers(productResults.map(p => p.sellers));

    const enhancedProducts = productsWithVariants.map(product => {
      const sellerRatings = ratingMap.get(product.seller_id) || [];
      const averageSellerRating = sellerRatings.length > 0
        ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(2)
        : "0.00";
      const totalFollowers = followerMap.get(product.seller_id) || 0;

      // Calculate per-product avg_rating and total_reviews
      let avg_rating = null;
      let total_reviews = 0;
      if (product.ratings && product.ratings.length > 0) {
        const sum = product.ratings.reduce((acc, r) => acc + r.rating, 0);
        avg_rating = (sum / product.ratings.length).toFixed(2);
        total_reviews = product.ratings.length;
      }

      return {
        ...product,
        seller_name: getUnifiedSellerName(product.sellers),
        seller_average_rating: averageSellerRating,
        seller_total_reviews: sellerRatings.length,
        total_followers: totalFollowers,
        avg_rating: avg_rating ? Number(avg_rating) : null,
        total_reviews: total_reviews,
        terjual: soldMap.get(product.id) || 0,
        is_delivery_available: product.sellers.is_delivery_available,
        ...(product.sellers.is_delivery_available && { delivery_fee: product.sellers.delivery_fee }),
        product_image_url: Array.isArray(product.product_image_url) ? product.product_image_url[0] || "" : product.product_image_url || "",
        sellers: undefined,
        ratings: undefined
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
      .select(`
        *,
        ratings!left(rating)
      `)
      .in("seller_id", sellerIds);

    if (productError) throw productError;

    const productsWithVariants = await attachVariantsStockDiscountWithRealDiscount(products);

    // Calculate total sold for each product
    const productIds = productsWithVariants.map(p => p.id);
    const soldMap = await calculateTotalSold(productIds);

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
      const averageSellerRating = sellerRatings.length > 0
        ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(2)
        : "0.00";
      const totalFollowers = followerMap.get(seller.id) || 0;
      const sellerProducts = productMap.get(seller.id) || [];
      const totalSold = sellerProducts.reduce((acc, p) => acc + (soldMap.get(p.id) || 0), 0);

      // Sort products: by sold_count desc, then by rating desc
      let products = sellerProducts.map(p => {
        let avg_rating = null;
        let total_reviews = 0;
        if (p.ratings && p.ratings.length > 0) {
          const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
          avg_rating = (sum / p.ratings.length).toFixed(2);
          total_reviews = p.ratings.length;
        }

        return {
          ...p,
          avg_rating: avg_rating ? Number(avg_rating) : null,
          total_reviews: total_reviews,
          terjual: soldMap.get(p.id) || 0,
          is_delivery_available: seller.is_delivery_available,
          ...(seller.is_delivery_available && { delivery_fee: seller.delivery_fee }),
          product_image_url: Array.isArray(p.product_image_url) ? p.product_image_url[0] || "" : p.product_image_url || "",
          ratings: undefined
        };
      }).sort((a, b) => {
        if ((b.terjual || 0) !== (a.terjual || 0)) {
          return (b.terjual || 0) - (a.terjual || 0);
        }
        return (b.avg_rating || 0) - (a.avg_rating || 0);
      }).slice(0, 3); // Take top 3

      return {
        ...seller,
        seller_name: getUnifiedSellerName(seller),
        products,
        average_rating: averageSellerRating,
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
// 🧠 Meta Produk (nama / keyword / varian / seller)
// ===============================
router.get("/meta", async (req, res) => {
  const { q = "", search_type } = req.query;

  try {
    const keyword = q.toLowerCase();
    const searchTerm = `%${keyword}%`; // Use raw keyword for ilike
    let products = [];

    if (search_type === "seller") {
      // Search sellers
      const { data: sellers, error: sellerError } = await supabase
        .from("sellers")
        .select("id, store_name, name, business_name")
        .or(
          `store_name.ilike.${searchTerm},name.ilike.${searchTerm},business_name.ilike.${searchTerm}`
        );

      if (sellerError) throw sellerError;

      if (sellers && sellers.length > 0) {
        const sellerIds = sellers.map((s) => s.id);
        const { data: sellerProducts, error: productError } = await supabase
          .from("products")
          .select(
            `*,
            sellers!inner(id, store_name, name, business_name, is_delivery_available, delivery_fee),
            ratings!left(rating)`
          )
          .in("seller_id", sellerIds);

        if (productError) throw productError;
        products = sellerProducts;
      }
    } else {
      // Search products by name or seller's store_name
      const { data: mainProducts, error: mainError } = await supabase
        .from("products")
        .select(
          `*,
          sellers!inner(id, store_name, name, business_name, is_delivery_available, delivery_fee),
          ratings!left(rating)`
        )
        .ilike("product_name", searchTerm);

      if (mainError) throw mainError;

      const { data: sellerProducts, error: sellerError } = await supabase
        .from("products")
        .select(
          `*,
          sellers!inner(id, store_name, name, business_name, is_delivery_available, delivery_fee),
          ratings!left(rating)`
        )
        .ilike("sellers.store_name", searchTerm);

      if (sellerError) throw sellerError;

      // Search by variant
      const { data: variantProducts, error: variantError } = await supabase
        .from("product_variants")
        .select("product_id, variant_name")
        .ilike("variant_name", searchTerm);

      if (variantError) throw variantError;

      const variantProductIds = [
        ...new Set(variantProducts.map((v) => v.product_id)),
      ];
      let additionalProducts = [];
      if (variantProductIds.length > 0) {
        const mainProductIds = mainProducts.map((p) => p.id);
        const sellerProductIds = sellerProducts.map((p) => p.id);
        const allCurrentIds = [...mainProductIds, ...sellerProductIds];
        const missingProductIds = variantProductIds.filter(
          (id) => !allCurrentIds.includes(id)
        );

        if (missingProductIds.length > 0) {
          const { data: missingProducts, error: missingError } = await supabase
            .from("products")
            .select(
              `*,
              sellers!inner(id, store_name, name, business_name, is_delivery_available, delivery_fee),
              ratings!left(rating)`
            )
            .in("id", missingProductIds);

          if (missingError) throw missingError;
          additionalProducts = missingProducts;
        }
      }

      // Combine and deduplicate products
      const allProducts = [...mainProducts, ...sellerProducts, ...additionalProducts];
      const uniqueProducts = Array.from(
        new Map(allProducts.map((p) => [p.id, p])).values()
      );
      products = uniqueProducts;
    }

    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(products);

    // Calculate total sold for each product
    const productIds = productsWithVariants.map(p => p.id);
    const soldMap = await calculateTotalSold(productIds);

    // Attach ratings and followers
    const { ratingMap, followerMap } = await attachRatingsAndFollowers(
      products.map((p) => p.sellers)
    );

    const enhancedProducts = productsWithVariants.map((product) => {
      const sellerRatings = ratingMap.get(product.seller_id) || [];
      const averageSellerRating =
        sellerRatings.length > 0
          ? (
              sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length
            ).toFixed(2)
          : "0.00";
      const totalFollowers = followerMap.get(product.seller_id) || 0;

      // Calculate per-product avg_rating and total_reviews
      let avg_rating = null;
      let total_reviews = 0;
      if (product.ratings && product.ratings.length > 0) {
        const sum = product.ratings.reduce((acc, r) => acc + r.rating, 0);
        avg_rating = (sum / product.ratings.length).toFixed(2);
        total_reviews = product.ratings.length;
      }

      return {
        ...product,
        seller_name: getUnifiedSellerName(product.sellers),
        seller_average_rating: averageSellerRating,
        seller_total_reviews: sellerRatings.length,
        total_followers: totalFollowers,
        avg_rating: avg_rating ? Number(avg_rating) : null,
        total_reviews: total_reviews,
        terjual: soldMap.get(product.id) || 0,
        is_delivery_available: product.sellers.is_delivery_available,
        ...(product.sellers.is_delivery_available && { delivery_fee: product.sellers.delivery_fee }),
        product_image_url: Array.isArray(product.product_image_url) ? product.product_image_url[0] || "" : product.product_image_url || "",
        sellers: undefined,
        ratings: undefined
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
// 🔍 Suggest Keywords + Produk
// ===============================
router.get("/suggest", async (req, res) => {
  const { q, limit = 10, search_type } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ message: '❌ Parameter "q" wajib diisi' });
  }

  try {
    const keyword = q.toLowerCase().trim();
    const searchTerm = `%${keyword}%`;

    let products = [];
    const keywordSet = new Set();
    const keywordsDisplay = []; // kumpulan keyword produk
    const sellerKeywords = []; // kumpulan seller name

    // ===============================
    // Case 1: Hanya cari seller
    // ===============================
    if (search_type === "seller") {
      const { data: sellers, error: sellerError } = await supabase
        .from("sellers")
        .select("id, store_name")
        .ilike("store_name", searchTerm)
        .limit(parseInt(limit));

      if (sellerError) throw sellerError;

      if (sellers && sellers.length > 0) {
        const sellerIds = sellers.map((s) => s.id);

        const { data: sellerProducts, error: productError } = await supabase
          .from("products")
          .select(`*, sellers!inner(id, store_name, email, is_delivery_available, delivery_fee), ratings!left(rating)`)
          .in("seller_id", sellerIds)
          .limit(parseInt(limit));

        if (productError) throw productError;
        products = sellerProducts;

        sellers.forEach((s) => {
          if (s.store_name?.toLowerCase().includes(keyword)) {
            if (!keywordSet.has(s.store_name.toLowerCase())) {
              keywordSet.add(s.store_name.toLowerCase());
              sellerKeywords.push(s.store_name);
            }
          }
        });
      }
    }

    // ===============================
    // Case 2: Produk + Seller (default)
    // ===============================
    else {
      const { data: productMatches, error: productError } = await supabase
        .from("products")
        .select(`*, sellers!inner(id, store_name, email, is_delivery_available, delivery_fee), ratings!left(rating)`)
        .ilike("product_name", searchTerm)
        .limit(parseInt(limit));

      if (productError) throw productError;

      const { data: sellerMatches, error: sellerError } = await supabase
        .from("sellers")
        .select("id, store_name")
        .ilike("store_name", searchTerm)
        .limit(parseInt(limit));

      if (sellerError) throw sellerError;

      let sellerProducts = [];
      if (sellerMatches && sellerMatches.length > 0) {
        const sellerIds = sellerMatches.map((s) => s.id);
        const { data, error } = await supabase
          .from("products")
          .select(`*, sellers!inner(id, store_name, email, is_delivery_available, delivery_fee), ratings!left(rating)`)
          .in("seller_id", sellerIds)
          .limit(parseInt(limit));

        if (error) throw error;
        sellerProducts = data || [];
      }

      products = [...(productMatches || []), ...(sellerProducts || [])];

      products.forEach((p) => {
        // ✅ Product keyword
        if (p.product_name?.toLowerCase().includes(keyword)) {
          if (!keywordSet.has(p.product_name.toLowerCase())) {
            keywordSet.add(p.product_name.toLowerCase());
            keywordsDisplay.push(p.product_name);
          }
        }
        // ✅ Seller keyword
        if (p.sellers?.store_name?.toLowerCase().includes(keyword)) {
          if (!keywordSet.has(p.sellers.store_name.toLowerCase())) {
            keywordSet.add(p.sellers.store_name.toLowerCase());
            sellerKeywords.push(p.sellers.store_name);
          }
        }
        // ✅ Custom keywords dari field products.keywords[]
        (p.keywords || [])
          .filter((k) => k.toLowerCase().includes(keyword))
          .forEach((k) => {
            if (!keywordSet.has(k.toLowerCase())) {
              keywordSet.add(k.toLowerCase());
              keywordsDisplay.push(k);
            }
          });
      });
    }

    // ===============================
    // Attach varian, diskon, rating
    // ===============================
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(products);

    // Calculate total sold for each product
    const productIds = productsWithVariants.map(p => p.id);
    const soldMap = await calculateTotalSold(productIds);

    const { ratingMap, followerMap } = await attachRatingsAndFollowers(
      products.map((p) => p.sellers)
    );

    const enhancedProducts = productsWithVariants.map((product) => {
      const sellerRatings = ratingMap.get(product.seller_id) || [];
      const averageSellerRating =
        sellerRatings.length > 0
          ? (
              sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length
            ).toFixed(2)
          : "0.00";
      const totalFollowers = followerMap.get(product.seller_id) || 0;

      // Calculate per-product avg_rating and total_reviews
      let avg_rating = null;
      let total_reviews = 0;
      if (product.ratings && product.ratings.length > 0) {
        const sum = product.ratings.reduce((acc, r) => acc + r.rating, 0);
        avg_rating = (sum / product.ratings.length).toFixed(2);
        total_reviews = product.ratings.length;
      }

      return {
        ...product,
        seller_name: product.sellers?.store_name,
        seller_email: product.sellers?.email,
        seller_average_rating: averageSellerRating,
        seller_total_reviews: sellerRatings.length,
        total_followers: totalFollowers,
        avg_rating: avg_rating ? Number(avg_rating) : null,
        total_reviews: total_reviews,
        terjual: soldMap.get(product.id) || 0,
        is_delivery_available: product.sellers.is_delivery_available,
        ...(product.sellers.is_delivery_available && { delivery_fee: product.sellers.delivery_fee }),
        product_image_url: Array.isArray(product.product_image_url) ? product.product_image_url[0] || "" : product.product_image_url || "",
        sellers: undefined,
        ratings: undefined
      };
    });

    // ===============================
    // Gabung keywords + seller
    // ===============================
    const combinedKeywords = [...keywordsDisplay];
    combinedKeywords.push({ seller: sellerKeywords });

    // ===============================
    // Response
    // ===============================
    res.status(200).json({
      message: "✅ Suggestion ditemukan",
      keywords: combinedKeywords,
      products: enhancedProducts,
    });
  } catch (error) {
    res.status(500).json({
      message: "❌ Gagal mengambil suggestion",
      error: error.message,
    });
  }
});

// ===============================
// 📦 Get All Produk (Paginated)
// ===============================
router.get("/allproduct", async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    // Ambil semua produk + rata-rata rating + data seller
    const { data: products, error } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left(rating),
        sellers!inner(id, name, email, phone, store_name, store_address, store_image_url, is_delivery_available, delivery_fee)
      `)
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    // Attach varian + stock + diskon
    const productsWithVariants = await attachVariantsStockDiscountWithRealDiscount(products);

    // Calculate total sold for each product
    const productIds = productsWithVariants.map(p => p.id);
    const soldMap = await calculateTotalSold(productIds);

    // Attach ratings and followers
    const { ratingMap, followerMap } = await attachRatingsAndFollowers(products.map(p => p.sellers));

    const enhancedProducts = productsWithVariants.map(product => {
      const sellerRatings = ratingMap.get(product.seller_id) || [];
      const averageSellerRating = sellerRatings.length > 0
        ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(2)
        : "0.00";
      const totalFollowers = followerMap.get(product.seller_id) || 0;

      // Calculate per-product avg_rating and total_reviews
      let avg_rating = null;
      let total_reviews = 0;
      if (product.ratings && product.ratings.length > 0) {
        const sum = product.ratings.reduce((acc, r) => acc + r.rating, 0);
        avg_rating = (sum / product.ratings.length).toFixed(2);
        total_reviews = product.ratings.length;
      }

      return {
        ...product,
        seller_name: getUnifiedSellerName(product.sellers),
        seller_average_rating: averageSellerRating,
        seller_total_reviews: sellerRatings.length,
        total_followers: totalFollowers,
        avg_rating: avg_rating ? Number(avg_rating) : null,
        total_reviews: total_reviews,
        terjual: soldMap.get(product.id) || 0,
        is_delivery_available: product.sellers.is_delivery_available,
        ...(product.sellers.is_delivery_available && { delivery_fee: product.sellers.delivery_fee }),
        product_image_url: Array.isArray(product.product_image_url) ? product.product_image_url[0] || "" : product.product_image_url || "",
        sellers: undefined,
        ratings: undefined
      };
    });

    return res.status(200).json({
      message: `✅ ${enhancedProducts.length} produk`,
      products: enhancedProducts,
      pagination: { limit: parseInt(limit), offset: parseInt(offset) },
    });
  } catch (error) {
    console.error("❌ Gagal ambil produk:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil semua produk",
      error: error.message,
    });
  }
});

module.exports = router;
