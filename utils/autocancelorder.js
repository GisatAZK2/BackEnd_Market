// file: jobs/autoCancelOrders.js
const cron = require("node-cron");
const supabase = require("../config/supabase");

// Jalan tiap 1 menit
cron.schedule("*/1 * * * *", async () => {
  try {
    const now = new Date().toISOString();
    let canceledCount = 0;

    // === Order menunggu konfirmasi seller (pickup / delivery) ===
  const { data: expiredUnconfirmed, error: unconfirmedError } = await supabase
  .from("orders")
  .select("id, pickup_method")
  .eq("status", "pending") // status pending
  .in("pickup_method", ["diantar", "diambil"]) // filter metode
  .lt("confirm_deadline", now); // deadline sudah lewat

    if (unconfirmedError) {
      console.error("❌ Gagal cek confirm deadline:", unconfirmedError);
    } else if (expiredUnconfirmed?.length) {
      const { error: cancelErr } = await supabase
        .from("orders")
        .update({
          status: "dibatalkan",
          cancel_reason:
            "❌ Batal otomatis karena seller tidak menerima order dalam batas waktu.",
        })
        .in(
          "id",
          expiredUnconfirmed.map((o) => o.id),
        );

      if (cancelErr) {
        console.error("❌ Gagal auto-cancel unconfirmed orders:", cancelErr);
      } else {
        canceledCount += expiredUnconfirmed.length;
        console.log(
          `⚡ Auto-cancel ${expiredUnconfirmed.length} pesanan (belum diterima seller).`,
        );
      }
    }

    // === Pickup expired ===
    const { data: expiredPickup, error: pickupError } = await supabase
      .from("orders")
      .select("id")
      .eq("status", "siap di ambil")
      .lt("pickup_deadline", now);

    if (pickupError) {
      console.error("❌ Gagal cek pickup deadline:", pickupError);
    } else if (expiredPickup?.length) {
      const { error: cancelErr } = await supabase
        .from("orders")
        .update({
          status: "dibatalkan",
          cancel_reason:
            "❌ Batal otomatis karena melewati batas waktu pengambilan.",
        })
        .in(
          "id",
          expiredPickup.map((o) => o.id),
        );

      if (cancelErr) {
        console.error("❌ Gagal auto-cancel pickup:", cancelErr);
      } else {
        canceledCount += expiredPickup.length;
        console.log(`⚡ Auto-cancel ${expiredPickup.length} pesanan pickup.`);
      }
    }

    // === Delivery expired ===
    const { data: expiredDelivery, error: deliveryError } = await supabase
      .from("orders")
      .select("id")
      .eq("status", "sedang di antar")
      .lt("delivery_deadline", now);

    if (deliveryError) {
      console.error("❌ Gagal cek delivery deadline:", deliveryError);
    } else if (expiredDelivery?.length) {
      const { error: cancelErr } = await supabase
        .from("orders")
        .update({
          status: "dibatalkan",
          cancel_reason:
            "❌ Batal otomatis karena melewati batas waktu pengiriman.",
        })
        .in(
          "id",
          expiredDelivery.map((o) => o.id),
        );

      if (cancelErr) {
        console.error("❌ Gagal auto-cancel delivery:", cancelErr);
      } else {
        canceledCount += expiredDelivery.length;
        console.log(
          `⚡ Auto-cancel ${expiredDelivery.length} pesanan delivery.`,
        );
      }
    }

    // === Kalau tidak ada yang expired ===
    if (canceledCount === 0) {
      console.log("ℹ️ Tidak ada pesanan yang dibatalkan.");
    }
  } catch (err) {
    console.error("❌ Auto-cancel job error:", err);
  }
});
