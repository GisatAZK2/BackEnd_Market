const express = require("express");
const supabase = require("../../config/supabase");
const sendOrderNotification = require("../../utils/statusorder");
const QRCode = require("qrcode");
const router = express.Router();


// ==================== UPDATE STATUS ORDER ====================
router.put("/orders/:id/status", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const orderId = req.params.id;
    const { action, barcodeId, paid } = req.body;

    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select("*, seller: sellers(*)")
      .eq("id", orderId)
      .eq("seller_id", sellerInfo.id)
      .single();

    if (fetchError || !order) {
      console.error("❌ Order tidak ditemukan:", fetchError);
      return res.status(404).json({ message: "❌ Order tidak ditemukan." });
    }

    let newStatus = "";
    let updatePayload = {};
    let validationError = null;

    const now = new Date();

    if (action === "accept") {
      if (order.pickup_method === "diantar") {
        newStatus = "sedang di antar";
        updatePayload.delivery_deadline = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      } else {
        newStatus = "sedang di packing";
        updatePayload.pickup_deadline = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
        updatePayload.latitude = order.seller.latitude;
        updatePayload.longitude = order.seller.longitude;
        updatePayload.alamat_lengkap = order.seller.alamat_lengkap;
      }
    }

    if (action === "complete") {
      if (!paid) validationError = "⚠️ Pembayaran belum dilakukan.";
      if (order.pickup_method === "diambil" && (!barcodeId || barcodeId !== order.id.toString()))
        validationError = "⚠️ Barcode ID tidak valid.";
      if (!validationError) newStatus = "selesai";
    }

    if (action === "cancel") {
      newStatus = "dibatalkan";
      updatePayload.cancel_reason = "❌ Dibatalkan sistem karena timeout";
    }

    if (validationError) return res.status(400).json({ message: validationError });

    updatePayload.status = newStatus;

    const { error: updateError } = await supabase
      .from("orders")
      .update(updatePayload)
      .eq("id", orderId);

    if (updateError) return res.status(500).json({ message: "❌ Gagal update order.", error: updateError.message });

    // Kirim notifikasi
    await sendOrderNotification({
      order_id: orderId,
      products: order.products,
      buyer_email: order.buyer_email,
      seller_email: order.seller.email,
      buyer_username: order.buyer_username,
      pickup_method: order.pickup_method,
    });

    return res.status(200).json({ message: `✅ Status order diubah menjadi '${newStatus}'`, ...updatePayload });

  } catch (err) {
    console.error("❌ Terjadi kesalahan server:", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server.", error: err.message });
  }
});

// ==================== VALIDASI BARCODE ====================
router.post("/orders/validate-barcode", async (req, res) => {
  const { barcodeId } = req.body;
  if (!barcodeId) return res.status(400).json({ message: "❌ Barcode ID diperlukan" });

  const { data: order, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", barcodeId)
    .single();

  if (error || !order) return res.status(404).json({ message: "❌ Order tidak ditemukan" });

  return res.status(200).json({
    order_id: order.id,
    paid: order.paid,
    status: order.status,
    message: order.paid ? "✅ Pesanan sudah dibayar" : "⚠️ Belum dibayar",
  });
});

// ==================== CRON JOB SIMPEL ====================
setInterval(async () => {
  const now = new Date().toISOString();

  // Cancel orders diantar lewat 1 hari
  const { data: expiredDiantar } = await supabase
    .from("orders")
    .select("*")
    .lt("delivery_deadline", now)
    .eq("status", "sedang di antar");

  for (const order of expiredDiantar) {
    await supabase.from("orders").update({
      status: "dibatalkan",
      cancel_reason: "❌ Dibatalkan sistem karena timeout pengiriman",
    }).eq("id", order.id);

    await sendOrderNotification({
      order_id: order.id,
      products: order.products,
      buyer_email: order.buyer_email,
      seller_email: order.seller.email,
      buyer_username: order.buyer_username,
      pickup_method: order.pickup_method,
    });
  }

  // Cancel orders diambil lewat 12 jam
  const { data: expiredDiambil } = await supabase
    .from("orders")
    .select("*")
    .lt("pickup_deadline", now)
    .eq("status", "sedang di packing");

  for (const order of expiredDiambil) {
    await supabase.from("orders").update({
      status: "dibatalkan",
      cancel_reason: "❌ Dibatalkan sistem karena timeout pengambilan",
    }).eq("id", order.id);

    await sendOrderNotification({
      order_id: order.id,
      products: order.products,
      buyer_email: order.buyer_email,
      seller_email: order.seller.email,
      buyer_username: order.buyer_username,
      pickup_method: order.pickup_method,
    });
  }
}, 10 * 60 * 1000); // tiap 10 menit

module.exports = router;
