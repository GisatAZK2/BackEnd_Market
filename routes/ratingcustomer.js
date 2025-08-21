// ratingRoutes.js
const express = require("express");
const multer = require("multer");
const supabase = require("../config/supabase");

const router = express.Router();
const upload = multer();

// ======================
// Middleware
// ======================
const requireUser = (req, res, next) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login." });
    }
    req.user = userInfo;
    next();
  } catch (err) {
    return res.status(400).json({ message: "❌ Cookie user_info tidak valid." });
  }
};

// ======================
// POST - Kasih Rating
// ======================
router.post("/:id/rating", upload.array("images"), async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login." });
    }

    const orderId = req.params.id;
    const { ratings } = JSON.parse(req.body.data);

    // ✅ Ambil order + order_items
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        id,
        status,
        user_id,
        order_items (id, product_id, variant_id)
      `)
      .eq("id", orderId)
      .single();

    if (orderError || !order) {
      return res.status(500).json({ message: "❌ Gagal ambil order." });
    }

    if (String(order.user_id) !== String(userInfo.id)) {
      return res.status(403).json({ message: "⚠️ Tidak punya akses ke order ini." });
    }

    if (order.status !== "diterima") {
      return res.status(400).json({ message: "⚠️ Hanya bisa kasih rating setelah order diterima." });
    }

    // Map order_items → validasi product_id & variant_id
    const validMap = new Map(
      order.order_items.map(i => [
        String(i.id).toLowerCase(),
        { product_id: i.product_id, variant_id: i.variant_id }
      ])
    );

    const resultRatings = [];

    for (const r of ratings) {
      const validItem = validMap.get(String(r.orderItemId).toLowerCase());
      if (!validItem) {
        console.log("⚠️ Item tidak valid:", r.orderItemId);
        continue;
      }

      // 🔎 Cek existing rating
      const { data: existing, error: existingError } = await supabase
        .from("ratings")
        .select("id")
        .eq("order_item_id", r.orderItemId)
        .eq("user_id", userInfo.id)
        .maybeSingle();

      if (existingError) {
        return res.status(500).json({ message: "❌ Gagal cek rating lama." });
      }
      if (existing) {
        return res.status(400).json({ message: "⚠️ Kamu sudah memberi rating untuk item ini." });
      }

      // 🔎 Upload image khusus untuk rating ini
      const reviewImages = [];
      if (req.files?.length) {
        for (const file of req.files.filter(f => r.images?.includes(f.originalname))) {
          const filePath = `reviews/${Date.now()}_${file.originalname}`;
          const { error: uploadError } = await supabase.storage
            .from("review-images")
            .upload(filePath, file.buffer, {
              contentType: file.mimetype,
              upsert: true,
            });

          if (uploadError) {
            return res.status(500).json({ message: "❌ Gagal upload gambar." });
          }

          const { data: publicUrl } = supabase.storage
            .from("review-images")
            .getPublicUrl(filePath);

          reviewImages.push(publicUrl.publicUrl);
        }
      }

      // 🔎 Ambil detail produk
      const { data: product } = await supabase
        .from("products")
        .select("id, product_name, product_image_url")
        .eq("id", validItem.product_id)
        .single();

      // 🔎 Ambil detail variant jika ada
      let variant = null;
      if (validItem.variant_id) {
        const { data: v } = await supabase
          .from("product_variants")
          .select("id, variant_name, variant_image_url")
          .eq("id", validItem.variant_id)
          .single();
        variant = v;
      }

      // 📦 Buat snapshot produk
      const productSnapshot = {
        product_id: product.id,
        product_name: product.product_name,
        product_image_url: product.product_image_url,
        variant_id: variant?.id || null,
        variant_name: variant?.variant_name || null,
        variant_image_url: variant?.variant_image_url || null,
      };

      // ➕ Insert rating
      const { data: inserted, error: insertError } = await supabase
        .from("ratings")
        .insert([{
          order_id: orderId,
          order_item_id: r.orderItemId,
          product_id: validItem.product_id,
          variant_id: validItem.variant_id || null,
          user_id: userInfo.id,
          rating: r.rating,
          review_text: r.reviewText,
          review_images: reviewImages,
          product_snapshot: productSnapshot,
        }])
        .select()
        .single();

      if (insertError) {
        return res.status(500).json({ message: "❌ Gagal insert rating." });
      }

      resultRatings.push(inserted);
    }

    if (resultRatings.length === 0) {
      return res.status(400).json({ message: "⚠️ Tidak ada rating valid." });
    }

    return res.status(200).json({
      message: "✅ Rating berhasil disimpan.",
      ratings: resultRatings,
    });
  } catch (err) {
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

// ======================
// GET semua rating user
// ======================
router.get("/all", requireUser, async (req, res) => {
  try {
    const { data: ratings } = await supabase
      .from("ratings")
      .select(`
        id,
        order_id,
        order_item_id,
        product_id,
        variant_id,
        rating,
        review_text,
        review_images,
        created_at,
        product_snapshot,
        rating_replies (
          id,
          reply_text,
          created_at,
          seller_id,
          sellers ( id, store_name, store_image_url )
        )
      `)
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .throwOnError();

    res.status(200).json({
      message: `✅ ${ratings.length} rating ditemukan`,
      ratings,
    });
  } catch (err) {
    console.error("❌ GET all rating error:", err);
    res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

// ======================
// GET rating per order
// ======================
router.get("/order/:orderId", requireUser, async (req, res) => {
  try {
    const orderId = req.params.orderId; // langsung pakai string UUID

    const { data: ratings, error } = await supabase
      .from("ratings")
      .select(`
        id,
        order_id,
        order_item_id,
        product_id,
        variant_id,
        rating,
        review_text,
        review_images,
        created_at,
        product_snapshot,
        rating_replies (
          id,
          reply_text,
          created_at,
          seller_id,
          sellers ( id, store_name, store_image_url )
        )
      `)
      .eq("user_id", req.user.id)
      .eq("order_id", orderId) // filter langsung ke kolom ratings.order_id
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.status(200).json({
      message: `✅ ${ratings.length} rating untuk order ${orderId}`,
      ratings,
    });
  } catch (err) {
    console.error("❌ GET rating order error:", err);
    res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

module.exports = router;
