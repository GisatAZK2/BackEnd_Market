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

//file mendapatkan semua seller
// GET Semua seller + produk + total produk terjual + followers
router.get("/allseller", async (req, res) => {
  const cached = cache.get("all_sellers_with_products");
  const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

  try {
    const { data: sellers, error: sellerError } = await supabase.from("sellers").select(`
      *,
      products (*)
    `);

    if (sellerError) {
      return res.status(500).json({
        message: "❌ Gagal mengambil data seller",
        error: sellerError.message,
      });
    }

    const allProducts = sellers.flatMap((s) => s.products);
    const productsWithVariants = await attachVariantsStockDiscountWithRealDiscount(allProducts);

    const productMap = new Map();
    for (const product of productsWithVariants) {
      if (!productMap.has(product.seller_id)) {
        productMap.set(product.seller_id, []);
      }
      productMap.get(product.seller_id).push(product);
    }

    // Ambil rating untuk semua produk
    const { data: ratings, error: ratingError } = await supabase
      .from("ratings")
      .select(`id, rating, product_id, products!inner(id, seller_id)`);

    if (ratingError) {
      return res.status(500).json({
        message: "❌ Gagal mengambil rating",
        error: ratingError.message,
      });
    }

    // Map rating per seller (untuk average_rating seller)
    const sellerRatingMap = new Map();
    // Map rating per product (untuk avg_rating dan total_ratings per produk)
    const productRatingMap = new Map();
    for (const r of ratings) {
      const sid = r.products.seller_id;
      const pid = r.product_id;

      if (!sellerRatingMap.has(sid)) sellerRatingMap.set(sid, []);
      sellerRatingMap.get(sid).push(r.rating);

      if (!productRatingMap.has(pid)) productRatingMap.set(pid, []);
      productRatingMap.get(pid).push(r.rating);
    }

    // Ambil followers semua seller
    const { data: followers, error: followerError } = await supabase
      .from("follows")
      .select("seller_id", { count: "exact", head: false });

    if (followerError) {
      return res.status(500).json({
        message: "❌ Gagal mengambil data followers",
        error: followerError.message,
      });
    }

    const followerMap = new Map();
    for (const f of followers) {
      const sid = f.seller_id;
      followerMap.set(sid, (followerMap.get(sid) || 0) + 1);
    }

    // Ambil semua seller yang di-follow user saat ini (kalau login)
    let followedSet = new Set();
    if (userInfo?.id) {
      const { data: userFollows, error: userFollowError } = await supabase
        .from("follows")
        .select("seller_id")
        .eq("user_id", userInfo.id);

      if (!userFollowError && userFollows) {
        followedSet = new Set(userFollows.map((f) => f.seller_id));
      }
    }

    const sellersWithProducts = sellers.map((seller) => {
      let products = productMap.get(seller.id) || [];

      // Tambahkan avg_rating, total_ratings, is_delivery_available, dan delivery_fee ke setiap produk (konsisten dengan file product)
      products = products.map((p) => {
        const productRatings = productRatingMap.get(p.id) || [];
        const avgRating = productRatings.length > 0
          ? Number((productRatings.reduce((a, b) => a + b, 0) / productRatings.length).toFixed(2))
          : null;

        return {
          ...p,
          avg_rating: avgRating,
          total_ratings: productRatings.length,
          is_delivery_available: seller.is_delivery_available,
          ...(seller.is_delivery_available && { delivery_fee: seller.delivery_fee })
        };
      });

      const totalSold = products.reduce((acc, p) => acc + (p.terjual || 0), 0);

      const sellerRatings = sellerRatingMap.get(seller.id) || [];
      const avgSellerRating =
        sellerRatings.length > 0
          ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(2)
          : "0.00";

      const totalFollowers = followerMap.get(seller.id) || 0;
      const isFollowed = followedSet.has(seller.id);

      return {
        seller: { ...seller, products: undefined },
        products,
        total_sold: totalSold,
        average_rating: avgSellerRating,
        total_reviews: sellerRatings.length,
        total_followers: totalFollowers,
        is_followed: isFollowed,
      };
    });

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

// GET Seller by ID + produk + followers + is_followed
router.get("/:id", async (req, res) => {
  const sellerId = req.params.id;
  const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

  const cached = cache.get(`seller_${sellerId}_${userInfo?.id || "guest"}`);
  if (cached) {
    return res.status(200).json({
      message: `✅ Seller & ${cached.products.length} produk berhasil diambil (cache)`,
      ...cached,
    });
  }

  try {
    // Ambil data seller
    const { data: seller, error: sellerError } = await supabase
      .from("sellers")
      .select("*")
      .eq("id", sellerId)
      .single();

    if (sellerError || !seller) {
      return res.status(404).json({ message: "❌ Seller tidak ditemukan" });
    }

    // Ambil produk seller dengan ratings
    const { data: products, error: productError } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        )
      `)
      .eq("seller_id", sellerId);

    if (productError) {
      return res.status(500).json({
        message: "❌ Gagal mengambil produk seller",
        error: productError.message,
      });
    }

    // Hitung avg_rating dan total_ratings per produk (konsisten dengan file product)
    let productsWithExtras = products.map((p) => {
      let avgRating = null;

      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }

      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
        is_delivery_available: seller.is_delivery_available,
        ...(seller.is_delivery_available && { delivery_fee: seller.delivery_fee })
      };
    });

    // Attach variants + stock + discount
    productsWithExtras = await attachVariantsStockDiscountWithRealDiscount(productsWithExtras);

    const totalSold = productsWithExtras.reduce(
      (acc, p) => acc + (p.terjual || 0),
      0
    );

    // Hitung followers seller ini
    const { count: followerCount, error: followerError } = await supabase
      .from("follows")
      .select("*", { count: "exact", head: true })
      .eq("seller_id", sellerId);

    if (followerError) {
      return res.status(500).json({
        message: "❌ Gagal mengambil jumlah followers",
        error: followerError.message,
      });
    }

    // Cek apakah user mengikuti seller ini
    let isFollowed = false;
    if (userInfo?.id) {
      const { data: followData, error: followError } = await supabase
        .from("follows")
        .select("id")
        .eq("user_id", userInfo.id)
        .eq("seller_id", sellerId)
        .maybeSingle();

      if (!followError && followData) {
        isFollowed = true;
      }
    }

    const result = {
      seller,
      products: productsWithExtras,
      total_sold: totalSold,
      total_followers: followerCount || 0,
      is_followed: isFollowed,
    };

    // Cache dengan key unik per user
    cache.set(`seller_${sellerId}_${userInfo?.id || "guest"}`, result);

    return res.status(200).json({
      message: `✅ Seller & ${productsWithExtras.length} produk berhasil diambil`,
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
        average_rating: "0.00", // selalu string 2 digit
        total_reviews: 0,
        ratings: [],
      });
    }

    const total = ratings.reduce((sum, r) => sum + r.rating, 0);
    const avg = total / ratings.length;

    return res.status(200).json({
      message: "✅ Rating seller berhasil diambil.",
      average_rating: avg.toFixed(2), // string, contoh "4.00"
      total_reviews: ratings.length,
      ratings,
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

// Follow seller (pakai upsert)
router.post("/sellers/:id/follow", async (req, res) => {
  const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
  if (!userInfo?.id) {
    return res.status(401).json({ message: "❌ Harus login." });
  }

  const sellerId = req.params.id;

  if (userInfo.seller_id === sellerId || userInfo.id === sellerId) {
    return res.status(400).json({ message: "❌ Tidak bisa follow diri sendiri." });
  }

  const { error } = await supabase
    .from("follows")
    .upsert([{ user_id: userInfo.id, seller_id: sellerId }], { onConflict: "user_id,seller_id" });

  if (error) return res.status(500).json({ message: "❌ Gagal follow.", error });

  res.json({ message: "✅ Berhasil follow seller." });
});

// Unfollow seller
router.delete("/sellers/:id/unfollow", async (req, res) => {
  const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
  if (!userInfo?.id) {
    return res.status(401).json({ message: "❌ Harus login." });
  }

  const sellerId = req.params.id;

  const { error } = await supabase
    .from("follows")
    .delete()
    .eq("user_id", userInfo.id)
    .eq("seller_id", sellerId);

  if (error) return res.status(500).json({ message: "❌ Gagal unfollow.", error });

  res.json({ message: "✅ Berhasil unfollow seller." });
});




module.exports = router;
