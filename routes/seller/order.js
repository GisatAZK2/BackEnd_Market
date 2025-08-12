const express = require("express");
const supabase = require("../../config/supabase");
const {
  attachVariantsStockDiscountWithRealDiscount,
  applyDiscount,
} = require("../../utils/applyDiscountAndVariants");
const router = express.Router();

// Seller update order status (1 route untuk semua aksi)
router.put("/seller/orders/:id/status", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id) {
      return res
        .status(401)
        .json({ message: "❌ Harus login sebagai seller." });
    }

    const orderId = req.params.id;
    const { action, latitude, longitude, barcodeId, paid } = req.body;

    // Ambil order dulu
    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select("id, pickup_method, status, buyer_id, seller_id")
      .eq("id", orderId)
      .eq("seller_id", sellerInfo.id)
      .single();

    if (fetchError || !order) {
      return res.status(404).json({ message: "❌ Order tidak ditemukan." });
    }

    let updatePayload = {};
    let newStatus = "";
    let validationError = null;

    switch (action) {
      case "accept":
        if (order.status !== "pending") {
          validationError = "⚠️ Order tidak dalam status pending.";
        } else {
          newStatus = "sedang di packing";
          if (order.pickup_method === "diambil") {
            if (!latitude || !longitude) {
              validationError = "⚠️ Lokasi toko wajib diisi untuk pickup.";
            } else {
              updatePayload.pickup_deadline = new Date(
                Date.now() + 6 * 60 * 60 * 1000,
              ).toISOString();
              updatePayload.latitude = latitude;
              updatePayload.longitude = longitude;
            }
          }
        }
        break;

      case "cancel":
        if (!["pending", "sedang di packing"].includes(order.status)) {
          validationError = "⚠️ Order tidak bisa dibatalkan pada status ini.";
        } else {
          newStatus = "dibatalkan";
        }
        break;

      case "complete":
        if (order.status !== "sedang di packing") {
          validationError = "⚠️ Order tidak dalam status sedang di packing.";
        } else if (!paid) {
          validationError = "⚠️ Pembayaran belum dilakukan.";
        } else if (
          order.pickup_method === "diambil" &&
          (!barcodeId || barcodeId !== order.id.toString())
        ) {
          validationError = "⚠️ Barcode ID tidak valid.";
        } else {
          newStatus = "selesai";
        }
        break;

      default:
        validationError = "⚠️ Aksi tidak dikenali.";
    }

    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    // Update status
    updatePayload.status = newStatus;
    const { error: updateError } = await supabase
      .from("orders")
      .update(updatePayload)
      .eq("id", orderId)
      .eq("seller_id", sellerInfo.id);

    if (updateError) {
      return res
        .status(500)
        .json({
          message: "❌ Gagal update order.",
          error: updateError.message,
        });
    }

    // Kirim notifikasi/email
    try {
      await sendOrderNotification({
        order_id: orderId,
        status: newStatus,
        buyer_id: order.buyer_id,
        seller_id: order.seller_id,
      });
    } catch (notifyErr) {
      console.error("❌ Gagal kirim notifikasi:", notifyErr.message);
    }

    return res
      .status(200)
      .json({ message: `✅ Status order diubah menjadi '${newStatus}'.` });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "❌ Terjadi kesalahan server.", error: err.message });
  }
});

module.exports = router;
