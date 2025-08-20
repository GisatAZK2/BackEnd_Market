const express = require("express");
const supabase = require("../../config/supabase");
const sendOrderNotification = require("../../utils/email");
const router = express.Router();

const {
  attachVariantsStockDiscountWithRealDiscount
} = require("../../utils/applyDiscountAndVariants");

const NodeCache = require("node-cache");
const orderCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });

function safeParseImageUrl(data) {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed[0];
    }
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return data; // fallback kalau bukan JSON valid
  }
}

router.get("/seller/all", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller untuk melihat daftar order." });
    }

    const cacheKey = `orders:seller:list:${sellerInfo.id}`;
    let orders = orderCache.get(cacheKey);
    if (orders) {
      return res.status(200).json({ message: "✅ Daftar order seller berhasil diambil (cache).", orders });
    }

    // 🔹 Ambil semua order milik seller
    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address")
      .eq("seller_id", sellerInfo.id)
      .order("created_at", { ascending: false });

    if (orderError) {
      return res.status(500).json({ message: "❌ Gagal mengambil data order seller.", error: orderError });
    }

    const orderIds = ordersData.map(o => o.id);
    if (!orderIds.length) {
      return res.status(200).json({ message: "✅ Tidak ada order.", orders: [] });
    }

    // 🔹 Ambil order_items & detailItems sekaligus
    const [orderItemsRes, detailItemsRes] = await Promise.all([
      supabase.from("order_items").select("order_id, product_id, variant_id, quantity").in("order_id", orderIds),
      supabase.from("order_details_items").select("*").in("order_id", orderIds),
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    // 🔹 Lookup quantity
    const orderItemMap = {};
    orderItems.forEach(oi => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      orderItemMap[key] = oi.quantity ?? 0;
    });

    // 🔹 Total quantity per order
    const qtyByOrder = {};
    orderItems.forEach(item => {
      if (!qtyByOrder[item.order_id]) qtyByOrder[item.order_id] = 0;
      qtyByOrder[item.order_id] += item.quantity ?? 0;
    });

    // 🔹 Map detailItems per order
    const itemsByOrder = {};
    detailItems.forEach(item => {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];

      const key = `${item.order_id}-${item.product_id}-${item.variant_id ?? "null"}`;
      const quantity = orderItemMap[key] ?? 0;

      itemsByOrder[item.order_id].push({
        order_item_id: item.order_item_id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity,
        price_per_item: item.variant_final_price ?? item.final_price ?? item.product_price,
        discount_percentage: item.variant_discount_percentage ?? item.discount_percentage ?? 0,
        variant: item.variant_id
          ? {
              id: item.variant_id,
              variant_name: item.variant_name,
              variant_image_url: item.variant_image_url,
              variant_price: item.variant_price,
              variant_final_price: item.variant_final_price,
              variant_discount_percentage: item.variant_discount_percentage,
            }
          : null,
      });
    });

    // 🔹 Gabungkan orders + items + buyer/seller info dari JSON
    orders = ordersData.map(order => {
      let buyerInfo = null;
      let buyerFullAddress = null;
      let sellerData = null;
      let sellerFullAddress = null;

      // 🔸 buyer_address
      if (order.buyer_address) {
        try {
          buyerInfo = typeof order.buyer_address === "string"
            ? JSON.parse(order.buyer_address)
            : order.buyer_address;

          const { alamat_lengkap = "", kelurahan = "", kecamatan = "", kota_kabupaten = "", provinsi = "", kode_pos = "" } = buyerInfo;
          buyerFullAddress = [alamat_lengkap, kelurahan, kecamatan, kota_kabupaten, provinsi, kode_pos].filter(Boolean).join(", ");
        } catch (e) {
          console.warn("⚠️ Gagal parse buyer_address:", order.buyer_address);
        }
      }

      // 🔸 seller_address (langsung dari JSON kolom orders)
      if (order.seller_address) {
        try {
          sellerData = typeof order.seller_address === "string"
            ? JSON.parse(order.seller_address)
            : order.seller_address;

          const { store_address = "", kelurahan = "", kecamatan = "", kota_kabupaten = "", provinsi = "" } = sellerData;
          sellerFullAddress = [store_address, kelurahan, kecamatan, kota_kabupaten, provinsi].filter(Boolean).join(", ");
        } catch (e) {
          console.warn("⚠️ Gagal parse seller_address:", order.seller_address);
        }
      }

      // 🔸 Jangan keluarkan seller_info kalau pickup_method = "kedua"
      return {
        ...order,
        order_items: itemsByOrder[order.id] || [],
        total_quantity: qtyByOrder[order.id] || 0,
        buyer_info: buyerInfo || null,
        buyer_full_address: buyerFullAddress || null,
        ...(order.pickup_method === "kedua"
          ? {}
          : {
              seller_info: sellerData || null,
              seller_full_address: sellerFullAddress || null,
            }),
      };
    });

    orderCache.set(cacheKey, orders);
    return res.status(200).json({ message: "✅ Daftar order seller berhasil diambil.", orders });
  } catch (err) {
    console.error("❌ Server error (seller/all):", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

router.get("/seller/:orderId", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const { orderId } = req.params;
    const cacheKey = `order:seller:${sellerInfo.id}:${orderId}`;

    const cached = orderCache.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        message: "✅ Detail order seller berhasil diambil (cache).",
        order: cached,
      });
    }

    // 🔹 Ambil order utama
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .select(
        "id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address"
      )
      .eq("id", orderId)
      .eq("seller_id", sellerInfo.id)
      .single();

    if (orderError || !orderData) {
      return res
        .status(404)
        .json({ message: "❌ Order tidak ditemukan.", error: orderError });
    }

    // 🔹 Ambil order_items & detailItems
    const [orderItemsRes, detailItemsRes] = await Promise.all([
      supabase
        .from("order_items")
        .select("order_id, product_id, variant_id, quantity")
        .eq("order_id", orderId),

      supabase.from("order_details_items").select("*").eq("order_id", orderId),
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    // 🔹 Lookup quantity
    const quantityMap = {};
    orderItems.forEach((oi) => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      quantityMap[key] = oi.quantity ?? 0;
    });

    const totalQuantity = orderItems.reduce(
      (sum, item) => sum + (item.quantity ?? 0),
      0
    );

    // 🔹 Map detailItems
    const items = detailItems.map((item) => {
      const key = `${item.order_id}-${item.product_id}-${item.variant_id ?? "null"}`;
      const quantity = quantityMap[key] ?? 0;

      return {
        order_item_id: item.order_item_id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity,
        price_per_item:
          item.variant_final_price ?? item.final_price ?? item.product_price,
        discount_percentage:
          item.variant_discount_percentage ?? item.discount_percentage ?? 0,
        variant: item.variant_id
          ? {
              id: item.variant_id,
              variant_name: item.variant_name,
              variant_image_url: item.variant_image_url,
              variant_price: item.variant_price,
              variant_final_price: item.variant_final_price,
              variant_discount_percentage: item.variant_discount_percentage,
            }
          : null,
      };
    });

    // 🔹 Parse buyer_address
    let buyerInfo = null,
      buyerFullAddress = null;
    if (orderData.buyer_address) {
      try {
        buyerInfo =
          typeof orderData.buyer_address === "string"
            ? JSON.parse(orderData.buyer_address)
            : orderData.buyer_address;

        const {
          alamat_lengkap = "",
          kelurahan = "",
          kecamatan = "",
          kota_kabupaten = "",
          provinsi = "",
          kode_pos = "",
        } = buyerInfo;

        buyerFullAddress = [
          alamat_lengkap,
          kelurahan,
          kecamatan,
          kota_kabupaten,
          provinsi,
          kode_pos,
        ]
          .filter(Boolean)
          .join(", ");
      } catch (e) {
        console.warn("⚠️ Gagal parse buyer_address:", orderData.buyer_address);
      }
    }

    // 🔹 Parse seller_address
    let sellerData = null,
      sellerFullAddress = null;
    if (orderData.seller_address) {
      try {
        sellerData =
          typeof orderData.seller_address === "string"
            ? JSON.parse(orderData.seller_address)
            : orderData.seller_address;

        const {
          store_address = "",
          kelurahan = "",
          kecamatan = "",
          kota_kabupaten = "",
          provinsi = "",
        } = sellerData;

        sellerFullAddress = [
          store_address,
          kelurahan,
          kecamatan,
          kota_kabupaten,
          provinsi,
        ]
          .filter(Boolean)
          .join(", ");
      } catch (e) {
        console.warn("⚠️ Gagal parse seller_address:", orderData.seller_address);
      }
    }

    // 🔹 Build result
    const orderResult = {
      ...orderData,
      order_items: items,
      total_quantity: totalQuantity,
      buyer_info: buyerInfo || null,
      buyer_full_address: buyerFullAddress || null,
      ...(orderData.pickup_method === "kedua"
        ? {}
        : {
            seller_info: sellerData || null,
            seller_full_address: sellerFullAddress || null,
          }),
    };

    // 🔹 Cache
    orderCache.set(cacheKey, orderResult);

    return res.status(200).json({
      message: "✅ Detail order seller berhasil diambil.",
      order: orderResult,
    });
  } catch (err) {
    console.error("❌ Server error (seller/:orderId):", err);
    return res
      .status(500)
      .json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

router.post("/ratings/:id/reply", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const ratingId = req.params.id;
    const { replyText } = req.body;

    if (!replyText || replyText.trim() === "") {
      return res.status(400).json({ message: "⚠️ Balasan tidak boleh kosong." });
    }

    // cek rating + pastikan rating memang produk seller ini
    const { data: rating, error: ratingErr } = await supabase
      .from("ratings")
      .select("id, product_id, order_item_id, order_id, products(seller_id)")
      .eq("id", ratingId)
      .single();

    if (ratingErr || !rating || rating.products?.seller_id !== sellerInfo.id) {
      return res.status(403).json({ message: "⚠️ Rating bukan milik produk Anda." });
    }

    // opsional: pastikan belum ada reply
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
    const { action, barcodeId } = req.body;

    // ===== 1. Ambil order utama =====
    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select(
        `
        *,
        buyer:users(email,username),
        seller:sellers(
          id,email,
          latitude,longitude,
          store_address,kelurahan,kecamatan,kabupaten,provinsi
        )
      `
      )
      .eq("id", orderId)
      .eq("seller_id", sellerInfo.id)
      .single();

    if (fetchError || !order) {
      return res.status(404).json({ message: "❌ Order tidak ditemukan." });
    }

    // ===== 2. Ambil order_items =====
    const { data: orderItems } = await supabase
      .from("order_items")
      .select("id, quantity, price_per_item, product_id, variant_id")
      .eq("order_id", orderId);

    // ===== 3. Ambil data produk =====
    const productIds = [...new Set(orderItems.map((i) => i.product_id))];
    let products = [];
    if (productIds.length > 0) {
      const { data: productData } = await supabase
        .from("products")
        .select("id, product_name, product_image_url")
        .in("id", productIds);
      products = productData || [];
    }

    // ===== 4. Ambil data variants =====
    const variantIds = orderItems.map((i) => i.variant_id).filter((id) => id !== null);
    let variants = [];
    if (variantIds.length > 0) {
      const { data: variantData } = await supabase
        .from("product_variants")
        .select("id, variant_name, variant_image_url")
        .in("id", variantIds);
      variants = variantData || [];
    }

    // ===== 5. Gabungkan order_items + produk + variants =====
    const itemsWithDetails = orderItems.map((item) => {
      const product = products.find((p) => p.id === item.product_id);
      const variant = variants.find((v) => v.id === item.variant_id);
      return { ...item, product: product || {}, variant: variant || null };
    });

    // ===== 6. Tentukan status baru berdasarkan action =====
    let newStatus = "";
    let updatePayload = {};
    const now = new Date();

    if (order.pickup_method === "diambil") {
      if (action === "accept") {
        newStatus = "sedang di kemas";
        updatePayload.confirm_deadline = null;
      } else if (action === "cancel") {
        newStatus = "dibatalkan";
        updatePayload.cancel_reason = "❌ Dibatalkan seller.";
      } else if (action === "ready") {
        newStatus = "siap di ambil";
        updatePayload.pickup_deadline = new Date(
          now.getTime() + 12 * 60 * 60 * 1000
        ).toISOString();
      } else if (action === "complete") {
        if (!barcodeId || barcodeId !== order.id.toString()) {
          return res.status(400).json({ message: "⚠ Barcode ID tidak valid." });
        }
        newStatus = "diterima";
      }
    }

    if (order.pickup_method === "diantar") {
      if (action === "accept") {
        newStatus = "sedang di kemas";
        updatePayload.confirm_deadline = null;
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
      return res.status(400).json({ message: "⚠ Aksi tidak valid." });
    }

    // ===== 6b. Cegah double request =====
    if (order.status === newStatus) {
      return res.status(200).json({
        message: `⚠ Order sudah berada di status '${newStatus}', tidak ada perubahan.`,
        order,
      });
    }

    // ===== 6c. Validasi transisi status =====
    const statusFlow = {
      pending: ["sedang di kemas", "dibatalkan"],
      "sedang di kemas": ["siap di ambil", "sedang di antar", "dibatalkan"],
      "siap di ambil": ["diterima"],
      "sedang di antar": ["diterima"],
    };

    const validNext = statusFlow[order.status] || [];
    if (!validNext.includes(newStatus)) {
      return res.status(400).json({
        message: `⚠ Status '${order.status}' tidak bisa langsung diubah ke '${newStatus}'.`,
      });
    }

    updatePayload.status = newStatus;

    // ===== 7. Tambah seller_address (JSON) =====
    updatePayload.seller_address = {
      store_address: order.seller.store_address,
      kelurahan: order.seller.kelurahan,
      kecamatan: order.seller.kecamatan,
      kabupaten: order.seller.kabupaten,
      provinsi: order.seller.provinsi,
      latitude: order.seller.latitude,
      longitude: order.seller.longitude,
    };

    // ===== 8. Update order =====
    const { data: updatedOrder, error: updateError } = await supabase
      .from("orders")
      .update(updatePayload)
      .eq("id", orderId)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ message: "❌ Gagal update order." });
    }

    // ===== 9. Format produk untuk email =====
    const productDetails = itemsWithDetails.map((i) => ({
      product_name: i.product.product_name,
      variant_name: i.variant?.variant_name || null,
      quantity: i.quantity,
      total_price: i.price_per_item * i.quantity,
      product_image_url:
        i.variant?.variant_image_url || safeParseImageUrl(i.product.product_image_url),
    }));

    // ===== 10. Kirim email =====
    await sendOrderNotification({
      order_id: orderId,
      products: productDetails,
      buyer_email: order.buyer?.email,
      seller_email: order.seller.email,
      buyer_username: order.buyer?.username,
      pickup_method: order.pickup_method,
      new_status: newStatus,
      seller_address: updatePayload.seller_address,
      cancel_reason: updatePayload.cancel_reason || null,
    });

    return res.status(200).json({
      message: `✅ Status order diubah menjadi '${newStatus}'`,
      order: updatedOrder,
    });
  } catch (err) {
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server.",
      error: err.message,
    });
  }
});



module.exports = router;
