// file: jobs/autoCancelOrders.js
const cron = require("node-cron");
const supabase = require("../config/supabase");
const axios = require("axios");

const SEND_URL = process.env.SEND_SERVICE_URL;

const buildProductDetails = (items, products, variants) =>
  items.map((item) => {
    const product = products?.find((p) => p.id === item.product_id);
    const variant = variants?.find((v) => v.id === item.variant_id);
    return {
      product_name: product?.product_name,
      variant_name: variant?.variant_name || null,
      quantity: item.quantity,
      total_price: item.price_per_item * item.quantity,
      product_image_url:
        variant?.variant_image_url ||
        JSON.parse(product?.product_image_url || "[]")[0] ||
        null,
    };
  });

// Helper untuk auto cancel + kirim notifikasi
const autoCancelOrders = async (orders, reason) => {
  if (!orders?.length) return 0;

  const orderIds = orders.map((o) => o.id);

  const { data: updated, error: cancelErr } = await supabase
    .from("orders")
    .update({
      status: "dibatalkan",
      cancel_reason: reason,
    })
    .in("id", orderIds)
    .select(
      `
      id, pickup_method, buyer:users(email,username),
      seller:sellers(email),
      order_items(id, quantity, price_per_item, product_id, variant_id)
    `
    );

  if (cancelErr) {
    console.error("❌ Gagal auto-cancel:", cancelErr);
    return 0;
  }

  // Kirim notifikasi untuk setiap order yang dibatalkan (non-blocking)
  for (const order of updated) {
    try {
      const productIds = [
        ...new Set(order.order_items.map((i) => i.product_id)),
      ];
      const variantIds = order.order_items
        .map((i) => i.variant_id)
        .filter(Boolean);

      const [{ data: products }, { data: variants }] = await Promise.all([
        supabase
          .from("products")
          .select("id, product_name, product_image_url")
          .in("id", productIds),
        supabase
          .from("product_variants")
          .select("id, variant_name, variant_image_url")
          .in("id", variantIds),
      ]);

      const productDetails = buildProductDetails(
        order.order_items,
        products,
        variants
      );
              // 🚀 Kirim email ke SMTP microservice (non-blocking, tidak pakai await)
        axios.post(`${SEND_URL}/send-email-order`, {
          order_id: order.id,
          products: productDetails,
          buyer_email: order.buyer?.email,
          seller_email: order.seller?.email,
          buyer_username: order.buyer?.username,
          pickup_method: order.pickup_method,
          new_status: "dibatalkan",
          cancel_reason: reason,
        })
        .catch((err) => {
          console.error(
            `❌ Gagal kirim notifikasi auto-cancel order ${order.id}:`,
            err.message
          );
        });

    } catch (notifyErr) {
      console.error(
        `❌ Error saat siapkan notifikasi order ${order.id}:`,
        notifyErr
      );
    }
  }

  return orders.length;
};

// === Jalankan tiap 1 menit ===
cron.schedule("*/1 * * * *", async () => {
  try {
    const now = new Date().toISOString();
    let canceledCount = 0;

    // === Order menunggu konfirmasi seller ===
    const { data: expiredUnconfirmed } = await supabase
      .from("orders")
      .select("id, pickup_method")
      .eq("status", "pending")
      .in("pickup_method", ["diantar", "diambil"])
      .lt("confirm_deadline", now);

    canceledCount += await autoCancelOrders(
      expiredUnconfirmed,
      "❌ Batal otomatis karena seller tidak menerima order dalam batas waktu."
    );

    // === Pickup expired ===
    const { data: expiredPickup } = await supabase
      .from("orders")
      .select("id, pickup_method")
      .eq("status", "siap di ambil")
      .lt("pickup_deadline", now);

    canceledCount += await autoCancelOrders(
      expiredPickup,
      "❌ Batal otomatis karena melewati batas waktu pengambilan."
    );

    // === Delivery expired ===
    const { data: expiredDelivery } = await supabase
      .from("orders")
      .select("id, pickup_method")
      .eq("status", "sedang di antar")
      .lt("delivery_deadline", now);

    canceledCount += await autoCancelOrders(
      expiredDelivery,
      "❌ Batal otomatis karena melewati batas waktu pengiriman."
    );

    if (canceledCount === 0) {
      console.log("ℹ️ Tidak ada pesanan yang dibatalkan.");
    } else {
      console.log(`⚡ Auto-cancel total ${canceledCount} pesanan.`);
    }
  } catch (err) {
    console.error("❌ Auto-cancel job error:", err);
  }
});
