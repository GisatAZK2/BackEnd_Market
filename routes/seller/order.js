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

// ======================
// GET Semua Order Seller
// ======================
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
      supabase.from("order_items").select("id, order_id, product_id, variant_id, quantity").in("order_id", orderIds),
      supabase.from("order_details_items").select("*").in("order_id", orderIds),
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    // 🔹 Lookup quantity
    const orderItemMap = {};
    orderItems.forEach(oi => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      orderItemMap[key] = { id: oi.id, quantity: oi.quantity ?? 0 };
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
      const match = orderItemMap[key] || { id: null, quantity: 0 };

      itemsByOrder[item.order_id].push({
        order_item_id: item.order_item_id, // dari detailItems
        orderItemId: match.id,       // dari order_items (buat rating)
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity: match.quantity,
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

      // 🔸 seller_address
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


// ======================
// GET Detail Order Seller
// ======================
router.get("/seller/:orderId", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const { orderId } = req.params;
    const cacheKey = `order:seller:${sellerInfo.id}:${orderId}`;
    const cached = orderCache.get(cacheKey);
    if (cached) {
      return res.status(200).json({ message: "✅ Detail order seller berhasil diambil (cache).", order: cached });
    }

    // 🔹 Ambil order utama
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address")
      .eq("id", orderId)
      .eq("seller_id", sellerInfo.id)
      .single();

    if (orderError || !orderData) {
      return res.status(404).json({ message: "❌ Order tidak ditemukan.", error: orderError });
    }

    // 🔹 Ambil order_items & detailItems
    const [orderItemsRes, detailItemsRes] = await Promise.all([
      supabase.from("order_items").select("id, order_id, product_id, variant_id, quantity").eq("order_id", orderId),
      supabase.from("order_details_items").select("*").eq("order_id", orderId),
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    // 🔹 Lookup quantity
    const orderItemMap = {};
    orderItems.forEach(oi => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      orderItemMap[key] = { id: oi.id, quantity: oi.quantity ?? 0 };
    });

    const totalQuantity = orderItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0);

    // 🔹 Map detailItems
    const items = detailItems.map(item => {
      const key = `${item.order_id}-${item.product_id}-${item.variant_id ?? "null"}`;
      const match = orderItemMap[key] || { id: null, quantity: 0 };

      return {
        order_item_id: item.order_item_id,
        orderItemId: match.id, // id asli dari tabel order_items
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity: match.quantity,
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
      };
    });

    // 🔹 Parse buyer_address
    let buyerInfo = null, buyerFullAddress = null;
    if (orderData.buyer_address) {
      try {
        buyerInfo = typeof orderData.buyer_address === "string"
          ? JSON.parse(orderData.buyer_address)
          : orderData.buyer_address;

        const { alamat_lengkap = "", kelurahan = "", kecamatan = "", kota_kabupaten = "", provinsi = "", kode_pos = "" } = buyerInfo;
        buyerFullAddress = [alamat_lengkap, kelurahan, kecamatan, kota_kabupaten, provinsi, kode_pos].filter(Boolean).join(", ");
      } catch (e) {
        console.warn("⚠️ Gagal parse buyer_address:", orderData.buyer_address);
      }
    }

    // 🔹 Parse seller_address
    let sellerData = null, sellerFullAddress = null;
    if (orderData.seller_address) {
      try {
        sellerData = typeof orderData.seller_address === "string"
          ? JSON.parse(orderData.seller_address)
          : orderData.seller_address;

        const { store_address = "", kelurahan = "", kecamatan = "", kota_kabupaten = "", provinsi = "" } = sellerData;
        sellerFullAddress = [store_address, kelurahan, kecamatan, kota_kabupaten, provinsi].filter(Boolean).join(", ");
      } catch (e) {
        console.warn("⚠️ Gagal parse seller_address:", orderData.seller_address);
      }
    }

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

    orderCache.set(cacheKey, orderResult);
    return res.status(200).json({ message: "✅ Detail order seller berhasil diambil.", order: orderResult });
  } catch (err) {
    console.error("❌ Server error (seller/:orderId):", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
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

    // ===== Helpers =====
    const fetchOrder = async () => {
      return await supabase
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
    };

    const fetchOrderItems = async () => {
      return await supabase
        .from("order_items")
        .select("id, quantity, price_per_item, product_id, variant_id")
        .eq("order_id", orderId);
    };

    const fetchProducts = async (productIds) => {
      if (productIds.length === 0) return [];
      const { data } = await supabase
        .from("products")
        .select("id, product_name, product_image_url")
        .in("id", productIds);
      return data || [];
    };

    const fetchVariants = async (variantIds) => {
      if (variantIds.length === 0) return [];
      const { data } = await supabase
        .from("product_variants")
        .select("id, variant_name, variant_image_url")
        .in("id", variantIds);
      return data || [];
    };

    const determineNewStatus = (order, action, barcodeId) => {
        const now = new Date();
        const payload = {};
        let status = "";

        const commonActions = {
            accept: () => {
              status = "sedang di kemas";
              payload.confirm_deadline = null;
            },
            cancel: () => {
              status = "dibatalkan";
              payload.cancel_reason = "❌ Dibatalkan seller.";
            },
          };

          if (commonActions[action]) {
            commonActions[action]();
          } else if (order.pickup_method === "diambil") {
            if (action === "ready") {
              status = "siap di ambil";
              payload.pickup_deadline = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
            } else if (action === "complete") {
              // barcodeId jadi opsional
              if (barcodeId && barcodeId !== order.id.toString()) {
                throw new Error("⚠ Barcode ID tidak valid.");
              }
              status = "diterima";
            }
          } else if (order.pickup_method === "diantar") {
            if (action === "ship") {
              status = "sedang di antar";
              payload.delivery_deadline = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
            } else if (action === "complete") {
              status = "diterima";
            }
        }

      return { status, payload };
      };

    const validateStatusFlow = (current, next) => {
      const statusFlow = {
        pending: ["sedang di kemas", "dibatalkan"],
        "sedang di kemas": ["siap di ambil", "sedang di antar", "dibatalkan"],
        "siap di ambil": ["diterima"],
        "sedang di antar": ["diterima"],
      };
      return statusFlow[current]?.includes(next);
    };

    const buildProductDetails = (items, products, variants) =>
      items.map((item) => {
        const product = products.find((p) => p.id === item.product_id);
        const variant = variants.find((v) => v.id === item.variant_id);
        return {
          product_name: product?.product_name,
          variant_name: variant?.variant_name || null,
          quantity: item.quantity,
          total_price: item.price_per_item * item.quantity,
          product_image_url:
            variant?.variant_image_url || safeParseImageUrl(product?.product_image_url),
        };
      });

    // ===== Main Flow =====
    const { data: order, error: fetchError } = await fetchOrder();
    if (fetchError || !order) {
      return res.status(404).json({ message: "❌ Order tidak ditemukan." });
    }

    const { data: orderItems, error: itemsError } = await fetchOrderItems();
    if (itemsError) {
      return res.status(500).json({ message: "❌ Gagal ambil order items." });
    }

    const productIds = [...new Set(orderItems.map((i) => i.product_id))];
    const variantIds = orderItems.map((i) => i.variant_id).filter(Boolean);

    const [products, variants] = await Promise.all([
      fetchProducts(productIds),
      fetchVariants(variantIds),
    ]);

    let newStatus, updatePayload;
    try {
      const result = determineNewStatus(order, action, barcodeId);
      newStatus = result.status;
      updatePayload = result.payload;
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    if (!newStatus) {
      return res.status(400).json({ message: "⚠ Aksi tidak valid." });
    }

    if (order.status === newStatus) {
      return res.status(200).json({
        message: `⚠ Order sudah di status '${newStatus}', tidak ada perubahan.`,
        order,
      });
    }

    if (!validateStatusFlow(order.status, newStatus)) {
      return res.status(400).json({
        message: `⚠ Status '${order.status}' tidak bisa langsung ke '${newStatus}'.`,
      });
    }

    updatePayload.status = newStatus;
    updatePayload.seller_address = {
      store_address: order.seller.store_address,
      kelurahan: order.seller.kelurahan,
      kecamatan: order.seller.kecamatan,
      kabupaten: order.seller.kabupaten,
      provinsi: order.seller.provinsi,
      latitude: order.seller.latitude,
      longitude: order.seller.longitude,
    };

    const { data: updatedOrder, error: updateError } = await supabase
      .from("orders")
      .update(updatePayload)
      .eq("id", orderId)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ message: "❌ Gagal update order." });
    }

    // update terjual batch jika order diterima
    if (newStatus === "diterima") {
      const { error: rpcError } = await supabase.rpc("increment_terjual", {
        order_id_input: orderId,
      });
      if (rpcError) console.error("⚠ Gagal update terjual batch:", rpcError.message);
    }

    const productDetails = buildProductDetails(orderItems, products, variants);

    // ⚡ Kirim email / notifikasi di background, tanpa blocking response
    sendOrderNotification({
      order_id: orderId,
      products: productDetails,
      buyer_email: order.buyer?.email,
      seller_email: order.seller.email,
      buyer_username: order.buyer?.username,
      pickup_method: order.pickup_method,
      new_status: newStatus,
      seller_address: updatePayload.seller_address,
      cancel_reason: updatePayload.cancel_reason || null,
    }).catch((err) => console.error("❌ Gagal kirim notifikasi:", err));

    // ✅ response cepat
    return res.status(200).json({
      message: `✅ Status order diubah ke '${newStatus}'`,
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
