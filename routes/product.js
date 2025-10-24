const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const sharp = require("sharp");
const supabase = require("../config/supabase");
const generateKeywords = require("../utils/keywordGenerator");
const seedrandom = require("seedrandom");
const {
  attachVariantsStockDiscountWithRealDiscount,
} = require("../utils/applyDiscountAndVariants");
const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 10 });

const router = express.Router();

let uniqueKeywords = [];

// === GET NEARBY ===
const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Nearby produk berdasarkan lokasi
router.get("/nearby-by-location", async (req, res) => {
  const { lat, lng } = req.query;
  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  if (isNaN(userLat) || isNaN(userLng)) {
    return res.status(400).json({ message: "❌ Koordinat tidak valid" });
  }

  try {
    const { data: sellers, error: sellerErr } = await supabase
      .from("sellers")
      .select("id, name, latitude, longitude, is_delivery_available, delivery_fee");

    if (sellerErr) throw sellerErr;

    const { data: products, error: prodErr } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        ),
        seller:sellers (
          id,
          name,
          email,
          phone,
          store_name,
          store_address,
          store_image_url,
          is_delivery_available,
          delivery_fee
        )
      `);

    if (prodErr) throw prodErr;

    // Gabungkan dengan data seller + hitung jarak
    const merged = products
      .map((product) => {
        const seller = sellers.find((s) => s.id === product.seller_id);
        const distanceInKm =
          seller && seller.latitude && seller.longitude
            ? haversineDistance(
                userLat,
                userLng,
                seller.latitude,
                seller.longitude
              )
            : Infinity;

        // Hitung avg rating
        let avgRating = null;
        if (product.ratings && product.ratings.length > 0) {
          const sum = product.ratings.reduce((acc, r) => acc + r.rating, 0);
          avgRating = sum / product.ratings.length;
        }

        return {
          ...product,
          sellerName: seller?.name,
          distanceInKm: +distanceInKm.toFixed(2),
          avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
          total_ratings: product.ratings ? product.ratings.length : 0,
          is_delivery_available: product.seller.is_delivery_available,
          ...(product.seller.is_delivery_available && { delivery_fee: product.seller.delivery_fee })
        };
      })
      .filter((p) => p.distanceInKm <= 40);

    // Tambahin varian + stok + diskon
    const mergedWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(merged);

    return res.status(200).json({
      message: `✅ Ditemukan ${mergedWithVariants.length} produk dalam radius 40 km`,
      products: mergedWithVariants,
    });
  } catch (error) {
    console.error("❌ Error nearby:", error);
    return res
      .status(500)
      .json({ message: "❌ Gagal mengambil produk nearby", error: error.message });
  }
});

// Produk terlaris (berdasarkan field "terjual" di tabel products)
router.get("/terlaris", async (req, res) => {
  try {
    // Ambil produk + rating
    const { data: products, error } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        ),
        seller:sellers (
          id,
          name,
          email,
          phone,
          store_name,
          store_address,
          store_image_url,
          is_delivery_available,
          delivery_fee
        )
      `);

    if (error) throw error;

    // Proses data -> tambahin avg rating + total terjual
    const processed = products.map((p) => {
      // Hitung rating
      let avgRating = null;
      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }

      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
        total_terjual: p.terjual ?? 0, // pake field "terjual"
        is_delivery_available: p.seller.is_delivery_available,
        ...(p.seller.is_delivery_available && { delivery_fee: p.seller.delivery_fee })
      };
    });

    // Urutkan produk terlaris (paling banyak terjual)
    const sorted = processed.sort((a, b) => b.total_terjual - a.total_terjual);

    // Attach varian + stok + diskon
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(sorted);

    return res.status(200).json({
      message: `🔥 ${productsWithVariants.length} produk terlaris`,
      products: productsWithVariants,
    });
  } catch (error) {
    console.error("❌ Error terlaris:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil produk terlaris",
      error: error.message,
    });
  }
});

router.get("/allproduct", async (req, res) => {
  try {
    // Ambil semua produk + rata-rata rating + data seller
    const { data: products, error } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        ),
        seller:sellers (
          id,
          name,
          email,
          phone,
          store_name,
          store_address,
          store_image_url,
          is_delivery_available,
          delivery_fee
        )
      `);

    if (error) throw error;

    // Hitung rata-rata rating per produk dan tambahkan field is_delivery_available dan delivery_fee
    const productsWithExtras = products.map((p) => {
      let avgRating = null;

      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }

      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
        is_delivery_available: p.seller.is_delivery_available,
        ...(p.seller.is_delivery_available && { delivery_fee: p.seller.delivery_fee })
      };
    });

    // Attach varian + stok + diskon
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(productsWithExtras);

    return res.status(200).json({
      message: `✅ ${products.length} produk`,
      products: productsWithVariants,
    });
  } catch (error) {
    console.error("❌ Gagal ambil produk:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil semua produk",
      error: error.message,
    });
  }
});

// Produk dengan urutan diskon terbesar
router.get("/sorted", async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        ),
        seller:sellers (
          id,
          name,
          email,
          phone,
          store_name,
          store_address,
          store_image_url,
          is_delivery_available,
          delivery_fee
        )
      `);

    if (error) throw error;

    // Hitung avg rating + total rating
    const productsWithExtras = products.map((p) => {
      let avgRating = null;

      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }

      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
        is_delivery_available: p.seller.is_delivery_available,
        ...(p.seller.is_delivery_available && { delivery_fee: p.seller.delivery_fee })
      };
    });

    // Attach varian + stok + diskon
    let productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(productsWithExtras);

    // Urutkan berdasarkan diskon terbesar
    productsWithVariants = productsWithVariants.sort(
      (a, b) => b.discountPercentage - a.discountPercentage
    );

    return res.status(200).json({
      message: `✅ ${productsWithVariants.length} produk (urut diskon terbesar)`,
      products: productsWithVariants,
    });
  } catch (error) {
    console.error("❌ Error sorted:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil semua produk",
      error: error.message,
    });
  }
});

// Produk trending
router.get("/trending", async (req, res) => {
  try {
    // 1. Ambil semua kategori
    const { data: categories, error: catErr } = await supabase
      .from("categories")
      .select("id, name");

    if (catErr) throw catErr;
    if (!categories || categories.length === 0) {
      return res.status(404).json({ message: "❌ Tidak ada kategori tersedia" });
    }

    // 2. Parse riwayat search dari cookie (personalization)
    let userSearchHistory = [];
    let mainCategoryFromHistory = null;
    const searchHistoryCookie = req.cookies?.user_search_history;
    if (searchHistoryCookie) {
      try {
        userSearchHistory = JSON.parse(decodeURIComponent(searchHistoryCookie));
        userSearchHistory = Array.isArray(userSearchHistory) ? userSearchHistory : [];
        
        const uniqueKeywords = [...new Set(
          userSearchHistory.flatMap(query => query.toLowerCase().split(/\s+/)).filter(k => k.length > 1)
        )].slice(0, 5);

        if (uniqueKeywords.length > 0) {
          const { data: matchingCategories } = await supabase
            .from("categories")
            .select("id, name")
            .or(uniqueKeywords.map(k => `name.ilike.%${k}%`).join(','));

          if (matchingCategories && matchingCategories.length > 0) {
            mainCategoryFromHistory = matchingCategories[Math.floor(Math.random() * matchingCategories.length)];
          }
        }
      } catch (parseErr) {
        console.warn("⚠️ Gagal parse search history cookie:", parseErr);
        userSearchHistory = [];
      }
    }

    // 3. Ambil semua produk dengan rating
    const { data: products, error: prodErr } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        ),
        seller:sellers (
          id,
          name,
          email,
          phone,
          store_name,
          store_address,
          store_image_url,
          is_delivery_available,
          delivery_fee
        )
      `);

    if (prodErr) throw prodErr;
    if (!products || products.length === 0) {
      return res.status(404).json({ message: "❌ Tidak ada produk tersedia" });
    }

    // 4. Hitung avg rating & total rating
    const productsWithExtras = products.map((p) => {
      let avgRating = null;
      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }
      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
        is_delivery_available: p.seller.is_delivery_available,
        ...(p.seller.is_delivery_available && { delivery_fee: p.seller.delivery_fee })
      };
    });

    // 5. Seed random pakai tanggal hari ini (untuk fallback)
    const today = new Date().toISOString().slice(0, 10);
    const rng = seedrandom(today);

    const pickRandom = (arr, count) => {
      const shuffled = [...arr].sort(() => rng() - 0.5);
      return shuffled.slice(0, count);
    };

    // 6. Tentukan main category: Prioritas dari history, fallback random
    let randomCategory = mainCategoryFromHistory;
    if (!randomCategory) {
      randomCategory = categories[Math.floor(rng() * categories.length)];
    }

    const fromCategory = productsWithExtras.filter(
      (p) => p.category_id === randomCategory.id
    );
    const otherProducts = productsWithExtras.filter(
      (p) => p.category_id !== randomCategory.id
    );

    // 7. Hitung jumlah produk trending 60% / 40%
    const totalTrending = Math.min(20, productsWithExtras.length);
    const catCount = Math.ceil(totalTrending * 0.6);
    const otherCount = totalTrending - catCount;

    const selectedFromCategory = pickRandom(fromCategory, catCount);
    const selectedFromOthers = pickRandom(otherProducts, otherCount);

    let trendingProducts = [...selectedFromCategory, ...selectedFromOthers];

    // 8. Attach varian + stok + diskon
    trendingProducts = await attachVariantsStockDiscountWithRealDiscount(
      trendingProducts
    );

    // 9. Acak lagi pakai seed supaya stabil sepanjang hari
    trendingProducts.sort(() => rng() - 0.5);

    // Response: Tambah info personalization
    return res.status(200).json({
      message: mainCategoryFromHistory 
        ? `🔥 Trending personal berdasarkan riwayat search Anda di kategori "${randomCategory.name}" (60%) + kategori lain (40%)`
        : `🔥 Trending produk dari kategori "${randomCategory.name}" (60%) + kategori lain (40%)`,
      date: today,
      total: trendingProducts.length,
      main_category: randomCategory.name,
      personalized: !!mainCategoryFromHistory,
      search_keywords_used: uniqueKeywords || [],
      products: trendingProducts,
    });
  } catch (error) {
    console.error("❌ Error trending:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil trending produk",
      error: error.message,
    });
  }
});

// Ambil produk berdasarkan kategori
router.get("/by-category/:category_id", async (req, res) => {
  const { category_id } = req.params;

  try {
    // Cek kategori ada atau nggak
    const { data: category, error: catErr } = await supabase
      .from("categories")
      .select("id, name")
      .eq("id", category_id)
      .single();

    if (catErr) throw catErr;
    if (!category)
      return res.status(404).json({ message: "❌ Kategori tidak ditemukan" });

    // Ambil produk berdasarkan kategori + rating + order_items (terjual)
    const { data: products, error: prodErr } = await supabase
      .from("products")
      .select(
        `
        *,
        ratings!left (
          rating
        ),
        order_items!left (
          quantity
        ),
        seller:sellers (
          id,
          name,
          email,
          phone,
          store_name,
          store_address,
          store_image_url,
          is_delivery_available,
          delivery_fee
        )
      `
      )
      .eq("category_id", category_id);

    if (prodErr) throw prodErr;

    // Hitung avg rating, total rating, & total sold
    const productsWithExtras = products.map((p) => {
      let avgRating = null;
      let totalSold = 0;

      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }

      if (p.order_items && p.order_items.length > 0) {
        totalSold = p.order_items.reduce((acc, o) => acc + o.quantity, 0);
      }

      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
        total_sold: totalSold,
        is_delivery_available: p.seller.is_delivery_available,
        ...(p.seller.is_delivery_available && { delivery_fee: p.seller.delivery_fee })
      };
    });

    // Attach varian + stok + diskon
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(productsWithExtras);

    // Response akhir
    return res.status(200).json({
      message: `✅ Ditemukan ${products.length} produk dalam kategori "${category.name}"`,
      category: category.name,
      products: productsWithVariants,
    });
  } catch (error) {
    console.error("❌ Error by-category:", error);
    return res.status(500).json({
      message: "❌ Server error",
      error: error.message,
    });
  }
});


function extractUUID(str) {
  const match = str.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}

// ================= GET PRODUCT =================
router.get("/:id", async (req, res) => {
  const { id: rawId } = req.params;
  const id = extractUUID(rawId);

  if (!id) {
    return res.status(400).json({ message: "❌ ID produk tidak valid" });
  }

  // Check cache
  const cached = cache.get(`product_${id}`);
  if (cached) {
    return res.status(200).json({
      message: "✅ Produk ditemukan (cache)",
      product: cached,
    });
  }

  try {
    const { data: product, error } = await supabase
      .from("products")
      .select(
        `
        id,
        product_name,
        product_description,
        product_price,
        product_image_url,
        stock,
        min_price,
        max_price,
        terjual,
        created_at,
        category_id,
        keywords,
        seller:sellers (
          id,
          name,
          email,
          phone,
          store_name,
          store_address,
          store_image_url,
          is_delivery_available,
          delivery_fee
        )
      `
      )
      .eq("id", id)
      .single();

    if (error || !product) {
      return res.status(404).json({ message: "❌ Produk tidak ditemukan" });
    }

    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount([product]);

    const result = {
      ...productsWithVariants[0],
      seller: {
        id: product.seller.id,
        name: product.seller.name,
        email: product.seller.email,
        phone: product.seller.phone,
        store_name: product.seller.store_name,
        store_address: product.seller.store_address,
        store_image_url: product.seller.store_image_url,
      },
      is_delivery_available: product.seller.is_delivery_available,
      ...(product.seller.is_delivery_available && {
        delivery_fee: product.seller.delivery_fee,
      }),
    };

    cache.set(`product_${id}`, result);
    return res.status(200).json({ message: "✅ Produk ditemukan", product: result });
  } catch (err) {
    return res.status(500).json({ message: "❌ Gagal mengambil produk", error: err.message });
  }
});

// ================= GET RATINGS =================
router.get("/:productId/ratings", async (req, res) => {
  const { productId: rawProductId } = req.params;
  const productId = extractUUID(rawProductId);

  if (!productId) {
    return res.status(400).json({ message: "❌ ID produk tidak valid" });
  }

  try {
    const { data: ratings, error } = await supabase
      .from("ratings")
      .select(
        `
        id,
        rating,
        review_text,
        review_images,
        created_at,
        user_id,
        users ( id, username, avatar ),
        rating_replies (
          id,
          reply_text,
          created_at,
          seller_id,
          sellers ( id, store_name, store_image_url )
        )
        `
      )
      .eq("product_id", productId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ message: "❌ Gagal ambil rating produk." });
    }

    if (!ratings || ratings.length === 0) {
      return res.status(200).json({
        message: "⚠️ Produk ini belum punya rating.",
        average_rating: 0,
        total_reviews: 0,
        ratings: [],
      });
    }

    const total = ratings.reduce((sum, r) => sum + r.rating, 0);
    const avg = total / ratings.length;

    return res.status(200).json({
      message: "✅ Rating produk berhasil diambil.",
      average_rating: Number(avg.toFixed(2)),
      total_reviews: ratings.length,
      ratings,
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

// ================= GET SUGGESTIONS =================
router.get("/:id/suggestions", async (req, res) => {
  const { id: rawId } = req.params;
  const id = extractUUID(rawId);

  if (!id) {
    return res.status(400).json({ message: "❌ ID produk tidak valid" });
  }

  try {
    // Fetch main product + ratings
    const { data: product, error: prodErr } = await supabase
      .from("products")
      .select(
        `
        *,
        ratings!left (
          rating
        ),
        seller:sellers (
          id,
          name,
          email,
          phone,
          store_name,
          store_address,
          store_image_url,
          is_delivery_available,
          delivery_fee
        )
      `
      )
      .eq("id", id)
      .single();

    if (prodErr) throw prodErr;
    if (!product) {
      return res.status(404).json({ message: "❌ Produk tidak ditemukan" });
    }

    // Hitung rata-rata rating
    let avgRating = null;
    if (product.ratings && product.ratings.length > 0) {
      const sum = product.ratings.reduce((acc, r) => acc + r.rating, 0);
      avgRating = sum / product.ratings.length;
    }
    const baseProduct = {
      id: product.id,
      name: product.product_name,
      avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
      total_ratings: product.ratings ? product.ratings.length : 0,
      is_delivery_available: product.seller.is_delivery_available,
      ...(product.seller.is_delivery_available && {
        delivery_fee: product.seller.delivery_fee,
      }),
    };

    if (!product.product_name) {
      return res.status(400).json({
        message: "❌ Produk tidak punya field product_name untuk pencarian terkait",
      });
    }

    // Buat keyword pencarian
    const keywords = product.product_name
      .split(" ")
      .filter((w) => w.length > 2);

    if (!keywords.length) {
      return res.status(200).json({
        message: "✅ Tidak ada keyword relevan untuk produk terkait",
        base_product: baseProduct,
        suggestions: [],
      });
    }

    const orFilter = keywords.map((kw) => `product_name.ilike.%${kw}%`).join(",");

    const { data: relatedProducts, error: relErr } = await supabase
      .from("products")
      .select(
        `
        *,
        ratings!left (
          rating
        ),
        seller:sellers (
          id,
          name,
          email,
          phone,
          store_name,
          store_address,
          store_image_url,
          is_delivery_available,
          delivery_fee
        )
      `
      )
      .or(orFilter)
      .neq("id", id)
      .limit(10);

    if (relErr) throw relErr;

    const relatedWithExtras = relatedProducts.map((p) => {
      let avgRating = null;
      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }
      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
        is_delivery_available: p.seller.is_delivery_available,
        ...(p.seller.is_delivery_available && {
          delivery_fee: p.seller.delivery_fee,
        }),
      };
    });

    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(relatedWithExtras);

    return res.status(200).json({
      message: `✅ ${productsWithVariants.length} produk terkait ditemukan`,
      base_product: baseProduct,
      suggestions: productsWithVariants,
    });
  } catch (error) {
    console.error("❌ Error suggestions:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil produk terkait",
      error: error.message,
    });
  }
});
module.exports = router;