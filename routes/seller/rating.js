const express = require("express");
const router = express.Router();
const supabase = require("../../config/supabase");

/**
 * POST /ratings/:id/reply
 * Seller balas rating (hanya 1x per rating)
 */
router.post("/ratings/:id/reply", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const ratingId = req.params.id;
    const { replyText } = req.body;

    if (!replyText || replyText.trim() === "") {
      return res.status(400).json({ message: "⚠️ Balasan tidak boleh kosong." });
    }

    // cek rating + validasi seller lewat orders!inner
    const { data: rating, error: ratingErr } = await supabase
      .from("ratings")
      .select(`
        id,
        order_id,
        orders!inner (seller_id)
      `)
      .eq("id", ratingId)
      .eq("orders.seller_id", sellerInfo.id)
      .single();

    if (ratingErr || !rating) {
      return res.status(403).json({ message: "⚠️ Rating bukan milik produk Anda." });
    }

    // cek jika sudah ada reply
    const { data: existingReply } = await supabase
      .from("rating_replies")
      .select("id")
      .eq("rating_id", ratingId)
      .maybeSingle();

    if (existingReply) {
      return res.status(400).json({ message: "⚠️ Rating ini sudah dibalas." });
    }

    // insert reply
    const { data, error } = await supabase
      .from("rating_replies")
      .insert([{ rating_id: ratingId, seller_id: sellerInfo.id, reply_text: replyText }])
      .select();

    if (error) return res.status(500).json({ message: "❌ Gagal simpan balasan.", error });

    return res.status(200).json({ message: "✅ Balasan berhasil ditambahkan.", reply: data[0] });
  } catch (err) {
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

/**
 * GET /ratings
 * Ambil semua rating milik seller (prioritas orders, fallback snapshot)
 */
router.get("/ratings", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    // --- Step 1: ambil semua rating yang masih punya orders
    const { data: ratingsByOrders, error: orderError } = await supabase
      .from("ratings")
      .select(`
        id,
        rating,
        review_text,
        review_images,
        created_at,
        product_snapshot,
        rating_replies(reply_text, created_at),
        orders!inner(seller_id)
      `)
      .eq("orders.seller_id", sellerInfo.id)
      .order("created_at", { ascending: false });

    if (orderError) {
      return res.status(500).json({ message: "❌ Gagal ambil rating (orders).", error: orderError });
    }

    // --- Step 2: cari orphan ratings (yang order_id sudah dihapus)
    const orphanIds = await supabase
      .from("ratings")
      .select("id, product_snapshot")
      .is("order_id", null); // langsung filter yg gak ada order

    if (orphanIds.error) {
      return res.status(500).json({ message: "❌ Gagal ambil orphan ratings.", error: orphanIds.error });
    }

    // Ambil hanya orphan yang benar-benar milik seller ini
    const orphanProductIds = [
      ...new Set(orphanIds.data.map(r => r.product_snapshot?.product_id).filter(Boolean))
    ];

    let ratingsBySnapshot = [];
    if (orphanProductIds.length > 0) {
      // Cari product orphan -> seller_id
      const { data: products, error: productError } = await supabase
        .from("products")
        .select("id")
        .eq("seller_id", sellerInfo.id) // langsung filter seller di DB
        .in("id", orphanProductIds);

      if (productError) {
        return res.status(500).json({ message: "❌ Gagal ambil produk orphan.", error: productError });
      }

      const validProductIds = products.map(p => p.id);

      if (validProductIds.length > 0) {
        const { data: orphanRatings, error: orphanError } = await supabase
          .from("ratings")
          .select(`
            id,
            rating,
            review_text,
            review_images,
            created_at,
            product_snapshot,
            rating_replies(reply_text, created_at)
          `)
          .in("product_snapshot->>product_id", validProductIds); // JSON filter

        if (orphanError) {
          return res.status(500).json({ message: "❌ Gagal ambil rating orphan.", error: orphanError });
        }

        ratingsBySnapshot = orphanRatings;
      }
    }

    // Gabungkan hasil
    const uniqueRatings = [...ratingsByOrders, ...ratingsBySnapshot];

    return res.status(200).json({
      message: `✅ ${uniqueRatings.length} rating ditemukan`,
      ratings: uniqueRatings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    });
  } catch (err) {
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});
/**
 * GET /ratings/:id
 * Ambil rating by ID (prioritas orders, fallback snapshot)
 */
router.get("/ratings/:id", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const ratingId = req.params.id;

    // --- Step 1: coba ambil rating via orders join
    const { data: ratingByOrder, error: orderError } = await supabase
      .from("ratings")
      .select(`
        id,
        rating,
        review_text,
        review_images,
        created_at,
        product_snapshot,
        rating_replies(reply_text, created_at),
        orders!inner(seller_id)
      `)
      .eq("id", ratingId)
      .eq("orders.seller_id", sellerInfo.id)
      .maybeSingle();

    if (orderError) {
      return res.status(500).json({ message: "❌ Gagal ambil rating (orders).", error: orderError });
    }

    if (ratingByOrder) {
      return res.status(200).json({ message: "✅ Rating ditemukan", rating: ratingByOrder });
    }

    // --- Step 2: fallback via product_snapshot (hanya kalau order_id null)
    const { data: rating, error: ratingError } = await supabase
      .from("ratings")
      .select(`
        id,
        rating,
        review_text,
        review_images,
        created_at,
        product_snapshot,
        rating_replies(reply_text, created_at)
      `)
      .eq("id", ratingId)
      .is("order_id", null) // langsung cek orphan
      .maybeSingle();

    if (ratingError) {
      return res.status(500).json({ message: "❌ Gagal ambil rating (snapshot).", error: ratingError });
    }

    if (!rating) {
      return res.status(404).json({ message: "⚠️ Rating tidak ditemukan." });
    }

    const productId = rating.product_snapshot?.product_id;
    if (!productId) {
      return res.status(403).json({ message: "⚠️ Rating ini tidak valid (product_id kosong)." });
    }

    // Pastikan product belong to seller
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("seller_id", sellerInfo.id)
      .maybeSingle();

    if (productError) {
      return res.status(500).json({ message: "❌ Gagal ambil produk.", error: productError });
    }

    if (!product) {
      return res.status(403).json({ message: "⚠️ Rating ini bukan milik Anda." });
    }

    return res.status(200).json({ message: "✅ Rating ditemukan", rating });
  } catch (err) {
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

module.exports = router;
