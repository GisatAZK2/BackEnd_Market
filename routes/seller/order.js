const express = require("express");
const supabase = require("../../config/supabase");
const sendOrderNotification = require("../../utils/email");
const router = express.Router();

const {
  attachVariantsStockDiscountWithRealDiscount
} = require("../../utils/applyDiscountAndVariants");

const NodeCache = require("node-cache");
const orderCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });


router.get("/all", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;

    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller untuk melihat daftar order." });
    }

    const cacheKey = `orders:seller:list:${sellerInfo.id}`;
    let orders = orderCache.get(cacheKey);

    if (!orders) {
      // Query orders yang berisi produk seller ini
      const { data: ordersData, error } = await supabase
        .from("orders")
        .select(`
          id,
          created_at,
          total_price,
          delivery_fee,
          status,
          pickup_method,
          pickup_deadline,
          order_items (
            id,
            product_id,
            variant_id,
            quantity,
            products (
              id,
              seller_id,
              product_name,
              product_image_url,
              product_price,
              stock,
              product_variants (
                id,
                variant_name,
                variant_image_url,
                variant_price
              )
            )
          )
        `)
        .order("created_at", { ascending: false });

      if (error) {
        return res.status(500).json({ message: "❌ Gagal mengambil data order seller.", error });
      }

      // Filter hanya order_items yang punya produk milik seller ini
      const filteredOrders = ordersData
        .map(order => {
          const filteredItems = order.order_items.filter(
            item => item.products && item.products.seller_id === sellerInfo.id
          );
          return filteredItems.length > 0 ? { ...order, order_items: filteredItems } : null;
        })
        .filter(Boolean);

      // Ambil semua produk unik dari order_items seller
      const allProducts = [];
      filteredOrders.forEach(order => {
        order.order_items.forEach(item => {
          if (item.products) allProducts.push(item.products);
        });
      });
      const uniqueProducts = [...new Map(allProducts.map(p => [p.id, p])).values()];

      // Enrich produk dengan diskon, stok, dll.
      const enrichedProducts = await attachVariantsStockDiscountWithRealDiscount(uniqueProducts);

      // Map orders final
      orders = filteredOrders.map(order => ({
        id: order.id,
        created_at: order.created_at,
        total_price: order.total_price,
        delivery_fee: order.pickup_method === "diantar" ? order.delivery_fee : 0,
        status: order.status,
        pickup_method: order.pickup_method,
        pickup_deadline: order.pickup_deadline,
        order_items: order.order_items.map(item => {
          const product = enrichedProducts.find(p => p.id === item.product_id);

          if (!product) {
            return {
              id: item.id,
              quantity: item.quantity,
              variant_id: item.variant_id,
              product: null,
            };
          }

          if (item.variant_id) {
            const variant = product.variants?.find(v => v.id === item.variant_id);

            const discountPercentage = variant?.applied_discount ?? 0;
            const finalPrice = variant?.final_price ?? variant?.variant_price;

            return {
              id: item.id,
              quantity: item.quantity,
              variant_id: item.variant_id,
              product: {
                ...product,
                variants: [variant],
              },
              discountPercentage,
              finalPrice,
            };
          }

          const discountPercentage = product.discountPercentage ?? 0;
          const finalPrice = product.finalPrice ?? product.product_price;

          return {
            id: item.id,
            quantity: item.quantity,
            variant_id: null,
            product,
            discountPercentage,
            finalPrice,
          };
        }),
      }));

      orderCache.set(cacheKey, orders);
    }

    return res.status(200).json({
      message: "✅ Daftar order seller berhasil diambil.",
      orders,
      cache: !!orderCache.get(cacheKey),
    });
  } catch (err) {
    console.error("❌ Server error (seller orders):", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});


// ==================== UPDATE STATUS ORDER ====================
router.put("/orders/:id/status", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    console.log("📦 Seller info dari cookies:", sellerInfo);

    if (!sellerInfo?.id) {
      console.log("❌ Tidak ada seller login!");
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const orderId = req.params.id;
    const { action, barcodeId } = req.body;

    console.log("➡ Request update order:", { orderId, action, barcodeId });

    // ===== 1. Ambil order utama (tanpa nested variants) =====
    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select(
        `
        *,
        buyer:users(email,username),
        seller:sellers(id,email,latitude,longitude,store_address)
      `
      )
      .eq("id", orderId)
      .eq("seller_id", sellerInfo.id)
      .single();

    if (fetchError || !order) {
      console.error("❌ Error ambil order:", fetchError);
      return res.status(404).json({ message: "❌ Order tidak ditemukan." });
    }

    console.log("✅ Order ditemukan:", {
      id: order.id,
      pickup_method: order.pickup_method,
      status: order.status,
    });

    // ===== 2. Ambil order_items =====
    const { data: orderItems, error: itemsError } = await supabase
      .from("order_items")
      .select("id, quantity, price_per_item, product_id, variant_id")
      .eq("order_id", orderId);

    if (itemsError) {
      console.error("❌ Error ambil order_items:", itemsError);
      return res.status(500).json({ message: "❌ Gagal ambil order items." });
    }

    // ===== 3. Ambil data produk =====
    const productIds = [...new Set(orderItems.map((i) => i.product_id))];
    let products = [];
    if (productIds.length > 0) {
      const { data: productData, error: prodError } = await supabase
        .from("products")
        .select("id, product_name, product_image_url")
        .in("id", productIds);

      if (prodError) {
        console.error("❌ Error ambil produk:", prodError);
      } else {
        products = productData;
      }
    }

    // ===== 4. Ambil data variants (product_variants) =====
    const variantIds = orderItems
      .map((i) => i.variant_id)
      .filter((id) => id !== null);

    let variants = [];
    if (variantIds.length > 0) {
      const { data: variantData, error: varError } = await supabase
        .from("product_variants")
        .select("id, variant_name, variant_image_url")
        .in("id", variantIds);

      if (varError) {
        console.error("❌ Error ambil variants:", varError);
      } else {
        variants = variantData;
      }
    }

    // ===== 5. Gabungkan order_items + produk + variants =====
    const itemsWithDetails = orderItems.map((item) => {
      const product = products.find((p) => p.id === item.product_id);
      const variant = variants.find((v) => v.id === item.variant_id);

      return {
        ...item,
        product: product || {},
        variant: variant || null,
      };
    });

    // ===== 6. Tentukan status baru =====
    let newStatus = "";
    let updatePayload = {};
    const now = new Date();

    // CASE PICKUP
    if (order.pickup_method === "diambil") {
      console.log("📍 Mode pickup (diambil)");

      if (action === "accept") {
        newStatus = "sedang di kemas";
      } else if (action === "cancel") {
        newStatus = "dibatalkan";
        updatePayload.cancel_reason = "❌ Dibatalkan seller.";
      } else if (action === "ready") {
        newStatus = "siap di ambil";
        updatePayload.pickup_deadline = new Date(
          now.getTime() + 12 * 60 * 60 * 1000
        ).toISOString();
        updatePayload.latitude = order.seller.latitude;
        updatePayload.longitude = order.seller.longitude;
        updatePayload.alamat_lengkap = order.seller.alamat_lengkap;
      } else if (action === "complete") {
        console.log("🔎 Cek barcode:", { barcodeId, expected: order.id });
        if (!barcodeId || barcodeId !== order.id.toString()) {
          console.warn("⚠ Barcode tidak valid!");
          return res.status(400).json({ message: "⚠ Barcode ID tidak valid." });
        }
        newStatus = "diterima";
      }
    }

    // CASE DELIVERY
    if (order.pickup_method === "diantar") {
      console.log("📍 Mode delivery (diantar)");

      if (action === "accept") {
        newStatus = "sedang di kemas";
      } else if (action === "cancel") {
        newStatus = "dibatalkan";
        updatePayload.cancel_reason = "❌ Dibatalkan seller.";
      } else if (action === "ship") {
        newStatus = "sedang di antar";
        updatePayload.delivery_deadline = new Date(
          now.getTime() + 12 * 60 * 60 * 1000
        ).toISOString();
      } else if (action === "complete") {
        newStatus = "diterima";
      }
    }

    if (!newStatus) {
      console.warn("⚠ Aksi tidak valid:", action);
      return res.status(400).json({
        message: "⚠ Aksi tidak valid untuk status pesanan ini.",
      });
    }

    updatePayload.status = newStatus;
    console.log("📝 Update payload:", updatePayload);

    // ===== 7. Update order =====
    const { data: updatedOrder, error: updateError } = await supabase
      .from("orders")
      .update(updatePayload)
      .eq("id", orderId)
      .select()
      .single();

    if (updateError) {
      console.error("❌ Gagal update order:", updateError);
      return res
        .status(500)
        .json({ message: "❌ Gagal update order.", error: updateError.message });
    }

    console.log("✅ Order berhasil diupdate:", {
      id: updatedOrder.id,
      status: updatedOrder.status,
    });

    // ===== 8. Format produk untuk email =====
    const productDetails = itemsWithDetails.map((i) => ({
      product_name: i.product.product_name,
      variant_name: i.variant?.variant_name || null,
      quantity: i.quantity,
      total_price: i.price_per_item * i.quantity,
      product_image_url: i.variant?.variant_image_url || i.product.product_image_url,
    }));

    console.log("📦 Produk dalam order:", productDetails);

    // ===== 9. Kirim email =====
    await sendOrderNotification({
      order_id: orderId,
      products: productDetails,
      buyer_email: order.buyer?.email,
      seller_email: order.seller.email,
      buyer_username: order.buyer?.username,
      pickup_method: order.pickup_method,
      new_status: newStatus,
    });

    console.log("📧 Email notifikasi terkirim");

    return res.status(200).json({
      message: `✅ Status order diubah menjadi '${newStatus}'`,
      order: updatedOrder,
    });
  } catch (err) {
    console.error("❌ Terjadi kesalahan server:", err);
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server.",
      error: err.message,
    });
  }
});

// ==================== VALIDASI BARCODE ====================
router.post("/orders/validate-barcode", async (req, res) => {
  const { barcodeId } = req.body;
  if (!barcodeId)
    return res.status(400).json({ message: "❌ Barcode ID diperlukan" });

  const { data: order, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", barcodeId)
    .single();

  if (error || !order)
    return res.status(404).json({ message: "❌ Order tidak ditemukan" });

  return res.status(200).json({
    order_id: order.id,
    paid: order.paid,
    status: order.status,
    message: order.paid ? "✅ Pesanan sudah dibayar" : "⚠ Belum dibayar",
  });
});

// ==================== CRON JOB SIMPEL ====================
setInterval(async () => {
  const now = new Date().toISOString();

  // Cancel orders diantar lewat 1 hari
  const { data: expiredDiantar } = await supabase
    .from("orders")
    .select("*, seller:sellers(id,email)")
    .lt("delivery_deadline", now)
    .eq("status", "sedang di antar");

  for (const order of expiredDiantar || []) {
    await supabase
      .from("orders")
      .update({
        status: "dibatalkan",
        cancel_reason: "❌ Dibatalkan sistem karena timeout pengiriman",
      })
      .eq("id", order.id);

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
    .select("*, seller:sellers(id,email)")
    .lt("pickup_deadline", now)
    .eq("status", "sedang di packing");

  for (const order of expiredDiambil || []) {
    await supabase
      .from("orders")
      .update({
        status: "dibatalkan",
        cancel_reason: "❌ Dibatalkan sistem karena timeout pengambilan",
      })
      .eq("id", order.id);

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
