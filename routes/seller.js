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

    // Ambil rating
    const { data: ratings, error: ratingError } = await supabase
      .from("ratings")
      .select(`id, rating, product_id, products!inner(id, seller_id)`);

    if (ratingError) {
      return res.status(500).json({
        message: "❌ Gagal mengambil rating",
        error: ratingError.message,
      });
    }

    const ratingMap = new Map();
    for (const r of ratings) {
      const sid = r.products.seller_id;
      if (!ratingMap.has(sid)) ratingMap.set(sid, []);
      ratingMap.get(sid).push(r.rating);
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
      const products = productMap.get(seller.id) || [];
      const totalSold = products.reduce((acc, p) => acc + (p.terjual || 0), 0);

      const sellerRatings = ratingMap.get(seller.id) || [];
      const avgRating =
        sellerRatings.length > 0
          ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(2)
          : "0.00";

      const totalFollowers = followerMap.get(seller.id) || 0;
      const isFollowed = followedSet.has(seller.id);

      return {
        seller: { ...seller, products: undefined },
        products,
        total_sold: totalSold,
        average_rating: avgRating,
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


// GET Seller by ID + produk + followers
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

    // Ambil produk seller
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

    const totalSold = productsWithVariants.reduce(
      (acc, p) => acc + (p.terjual || 0),
      0
    );

    // hitung followers seller ini
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

    // cek apakah user mengikuti seller ini
    let isFollowed = false;
    if (userInfo?.id) {
      const { data: followData, error: followError } = await supabase
        .from("follows")
        .select("id")
        .eq("user_id", userInfo.id)
        .eq("seller_id", sellerId)
        .maybeSingle(); // gunakan maybeSingle agar tidak error jika tidak ada

      if (!followError && followData) {
        isFollowed = true;
      }
    }

    const result = {
      seller,
      products: productsWithVariants,
      total_sold: totalSold,
      total_followers: followerCount || 0,
      is_followed: isFollowed,
    };

    // cache dengan key unik per user
    cache.set(`seller_${sellerId}_${userInfo?.id || "guest"}`, result);

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

// Follow seller
router.post("/sellers/:id/follow", async (req, res) => {
  const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
  if (!userInfo?.id) {
    return res.status(401).json({ message: "❌ Harus login." });
  }

  const sellerId = req.params.id;

  // Cegah follow diri sendiri
  if (userInfo.seller_id === sellerId || userInfo.id === sellerId) {
    return res.status(400).json({ message: "❌ Tidak bisa follow diri sendiri." });
  }

  // Insert follow (ignore duplicate jika sudah ada)
  const { error } = await supabase
    .from("follows")
    .insert([{ user_id: userInfo.id, seller_id: sellerId }], { ignoreDuplicates: true });

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
