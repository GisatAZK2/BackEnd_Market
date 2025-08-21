const express = require("express");
const router = express.Router();
const supabase = require("../../config/supabase");

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

    // cek rating + pastikan rating milik produk seller
    const { data: rating, error: ratingErr } = await supabase
      .from("ratings")
      .select("id, product_id, products(seller_id)")
      .eq("id", ratingId)
      .single();

    if (ratingErr || !rating || rating.products?.seller_id !== sellerInfo.id) {
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
 * Ambil semua rating milik seller, termasuk product_variants
 */
router.get("/ratings", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id)
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });

    // Ambil rating + join ke orders untuk filter seller_id
    const { data, error } = await supabase
      .from("ratings")
      .select(`
        *,
        rating_replies(reply_text, created_at),
        orders(seller_id)
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
 * Ambil rating by ID (pastikan milik seller) + product_variants
 */
router.get("/ratings/:id", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id)
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });

    const ratingId = req.params.id;

    // Ambil rating tertentu + join ke orders untuk validasi seller_id
    const { data, error } = await supabase
      .from("ratings")
      .select(`
        *,
        rating_replies(reply_text, created_at),
        orders(seller_id)
      `)
      .eq("id", ratingId)
      .eq("orders.seller_id", sellerInfo.id)
      .single();

    if (error)
      return res.status(500).json({ message: "❌ Gagal ambil rating.", error });

    if (!data)
      return res.status(404).json({ message: "❌ Rating tidak ditemukan atau bukan milik seller ini." });

    return res.status(200).json({ message: "✅ Rating ditemukan", rating: data });
  } catch (err) {
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});


module.exports = router;
