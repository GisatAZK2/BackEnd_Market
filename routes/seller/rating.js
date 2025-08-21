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
 * Ambil semua rating milik seller
 */
router.get("/ratings", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id)
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });

    const { data, error } = await supabase
      .from("ratings")
      .select(`
        id,
        rating,
        review_text,
        review_images,
        created_at,
        product_snapshot,
        rating_replies(reply_text, created_at),
        orders!inner (seller_id)
      `)
      .eq("orders.seller_id", sellerInfo.id)
      .order("created_at", { ascending: false });

    if (error)
      return res.status(500).json({ message: "❌ Gagal ambil rating.", error });

    return res
      .status(200)
      .json({ message: `✅ ${data.length} rating ditemukan`, ratings: data });
  } catch (err) {
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

/**
 * GET /ratings/:id
 * Ambil rating by ID (pastikan milik seller)
 */
router.get("/ratings/:id", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id)
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });

    const ratingId = req.params.id;

    const { data, error } = await supabase
      .from("ratings")
      .select(`
        id,
        rating,
        review_text,
        review_images,
        created_at,
        product_snapshot,
        rating_replies(reply_text, created_at),
        orders!inner (seller_id)
      `)
      .eq("id", ratingId)
      .eq("orders.seller_id", sellerInfo.id)
      .maybeSingle(); // 🔥 aman kalau 0 row

    if (error) {
      return res.status(500).json({ message: "❌ Gagal ambil rating.", error });
    }

    if (!data) {
      return res.status(403).json({ message: "⚠️ Rating ini bukan milik Anda." });
    }

    return res.status(200).json({ message: "✅ Rating ditemukan", rating: data });
  } catch (err) {
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

module.exports = router;
