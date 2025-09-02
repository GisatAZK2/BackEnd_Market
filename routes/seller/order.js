// order.js
const express = require("express");
const supabase = require("../../config/supabase");
const sendOrderNotification = require("../../utils/email");
const router = express.Router();
const awdcustomer = require("./awb");

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

    // 🔹 Ambil semua order milik seller kecuali yang statusnya dibatalkan/diterima oleh pembeli
    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address")
      .eq("seller_id", sellerInfo.id)
      .not("status", "in", "(dibatalkan,\"diterima oleh pembeli\")")
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
        orderItemId: match.id,             // dari order_items (buat rating)
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
// GET Order Dibatalkan Seller
// ======================
router.get("/seller/cancelled", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller untuk melihat daftar order dibatalkan." });
    }

    const cacheKey = `orders:seller:cancelled:${sellerInfo.id}`;
    let orders = orderCache.get(cacheKey);
    if (orders) {
      return res.status(200).json({ message: "✅ Daftar order dibatalkan seller berhasil diambil (cache).", orders });
    }

    // 🔹 Ambil order dibatalkan milik seller
    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address")
      .eq("seller_id", sellerInfo.id)
      .eq("status", "dibatalkan")
      .order("created_at", { ascending: false });

    if (orderError) {
      return res.status(500).json({ message: "❌ Gagal mengambil data order dibatalkan seller.", error: orderError });
    }

    const orderIds = ordersData.map(o => o.id);
    if (!orderIds.length) {
      return res.status(200).json({ message: "✅ Tidak ada order dibatalkan.", orders: [] });
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
        order_item_id: item.order_item_id,
        orderItemId: match.id,
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

    // 🔹 Gabungkan orders + items + buyer/seller info
    orders = ordersData.map(order => {
      let buyerInfo = null;
      let buyerFullAddress = null;
      let sellerData = null;
      let sellerFullAddress = null;

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
        seller_info: sellerData || null,
        seller_full_address: sellerFullAddress || null,
      };
    });

    orderCache.set(cacheKey, orders);
    return res.status(200).json({ message: "✅ Daftar order dibatalkan seller berhasil diambil.", orders });
  } catch (err) {
    console.error("❌ Server error (seller/cancelled):", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// ======================
// GET Order Diterima Seller
// ======================
router.get("/seller/completed", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller untuk melihat daftar order diterima." });
    }

    const cacheKey = `orders:seller:completed:${sellerInfo.id}`;
    let orders = orderCache.get(cacheKey);
    if (orders) {
      return res.status(200).json({ message: "✅ Daftar order diterima seller berhasil diambil (cache).", orders });
    }

    // 🔹 Ambil order diterima milik seller
    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address")
      .eq("seller_id", sellerInfo.id)
      .eq("status", "diterima oleh pembeli")
      .order("created_at", { ascending: false });

    if (orderError) {
      return res.status(500).json({ message: "❌ Gagal mengambil data order diterima seller.", error: orderError });
    }

    const orderIds = ordersData.map(o => o.id);
    if (!orderIds.length) {
      return res.status(200).json({ message: "✅ Tidak ada order diterima.", orders: [] });
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
        order_item_id: item.order_item_id,
        orderItemId: match.id,
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

    // 🔹 Gabungkan orders + items + buyer/seller info
    orders = ordersData.map(order => {
      let buyerInfo = null;
      let buyerFullAddress = null;
      let sellerData = null;
      let sellerFullAddress = null;

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
        seller_info: sellerData || null,
        seller_full_address: sellerFullAddress || null,
      };
    });

    orderCache.set(cacheKey, orders);
    return res.status(200).json({ message: "✅ Daftar order diterima seller berhasil diambil.", orders });
  } catch (err) {
    console.error("❌ Server error (seller/completed):", err);
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
  const PDFDocument = require('pdfkit');
  const QRCode = require('qrcode');
  const axios = require('axios');

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
          buyer:users(nama_penerima, no_telepon, email, username),
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
          if (order.pickup_method === "diambil" && barcodeId && barcodeId !== order.id.toString()) {
            throw new Error("⚠ Barcode ID tidak valid.");
          }
          status = "diterima";
          payload.confirm_by_buyers_deadline = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString();
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

    // ===== Generate PDF Function (for diambil on sedang di kemas) =====
    const generatePDF = async (order) => {
      const qrData = JSON.stringify({
        orderId: order.id,
        sellerId: sellerInfo.id,
        date: order.created_at,
      });
      const qrCode = await QRCode.toDataURL(qrData, { width: 100 });

      let logoBuffer;
      try {
        const logoUrl = "https://hihfiptclwrwuklojdec.supabase.co/storage/v1/object/public/store-photos/BG-Logo-Aplikasi.png";
        const response = await axios.get(logoUrl, { responseType: "arraybuffer" });
        logoBuffer = Buffer.from(response.data);
      } catch {
        logoBuffer = null;
      }

      const buyerAddress = typeof order.buyer_address === "string" ? JSON.parse(order.buyer_address) : order.buyer_address;
      const sellerAddress = typeof order.seller_address === "string" ? JSON.parse(order.seller_address) : order.seller_address;

      const buyerFullAddress = [
        buyerAddress?.alamat_lengkap,
        buyerAddress?.kelurahan,
        buyerAddress?.kecamatan,
        buyerAddress?.kota_kabupaten,
        buyerAddress?.provinsi,
        buyerAddress?.kode_pos,
      ].filter(Boolean).join(", ");

      const sellerFullAddress = [
        sellerAddress?.store_address,
        sellerAddress?.kelurahan,
        sellerAddress?.kecamatan,
        sellerAddress?.kota_kabupaten,
        sellerAddress?.provinsi,
        sellerAddress?.kode_pos,
      ].filter(Boolean).join(", ");

      // Fetch items for PDF
      const [orderItemsRes, detailItemsRes] = await Promise.all([
        supabase.from("order_items").select("*").eq("order_id", order.id),
        supabase.from("order_details_items").select("*").eq("order_id", order.id),
      ]);

      const orderItems = orderItemsRes.data || [];
      const detailItems = detailItemsRes.data || [];

      const itemsList = detailItems.map(item => {
        const oi = orderItems.find(oi => oi.product_id === item.product_id && oi.variant_id === item.variant_id);
        return {
          product_name: item.product_name,
          variant_name: item.variant_name || null,
          quantity: oi?.quantity || 0,
        };
      });

      return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [252, 400], margin: 10 });
        const buffers = [];
        doc.on("data", buffers.push.bind(buffers));
        doc.on("end", () => resolve(Buffer.concat(buffers)));

        // Border
        doc.lineWidth(1).rect(18, 18, 216, 360).strokeColor("#d1d5db").stroke();

        // Header
        if (logoBuffer) {
          doc.image(logoBuffer, 20, 20, { width: 30, height: 30 });
        }
        doc.fontSize(14).font("Helvetica-Bold").fillColor("#1e40af").text("SHIPPING LABEL", 55, 25);
        doc.fontSize(8).font("Helvetica").fillColor("#6b7280").text(`ID: ${order.id}`, 55, 42);
        doc.roundedRect(180, 25, 40, 15, 4).fillColor("#dbeafe").fill();
        doc.fontSize(8).font("Helvetica-Bold").fillColor("#1e40af").text(order.pickup_method.toUpperCase(), 180, 30, { align: "center", width: 40 });
        doc.moveTo(20, 50).lineTo(232, 50).lineWidth(1).strokeColor("#d1d5db").stroke();

        // Instruksi Pengambilan for "diambil"
        doc.fontSize(8).font("Helvetica-Bold").fillColor("#1d4ed8").text("Instruksi Pengambilan", 20, 60);
        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000").text("Ambil di Toko", 25, 75, { width: 95 });
        doc.fontSize(7).font("Helvetica").text(sellerFullAddress, 25, 90, { width: 105 });
        const hAddr = doc.heightOfString(sellerFullAddress, { width: 105 });
        var receiverBottom = 90 + hAddr + 5;

        // Pengirim
        doc.fontSize(8).font("Helvetica-Bold").fillColor("#1d4ed8").text("Pengirim", 140, 60);
        let ySend = 75;
        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000").text(sellerInfo.store_name || "Toko Anda", 145, ySend, { width: 85 });
        ySend += 12;
        const hSend = doc.heightOfString(sellerFullAddress, { width: 85 });
        doc.fontSize(7).font("Helvetica").text(sellerFullAddress, 145, ySend, { width: 85 });
        const senderBottom = ySend + hSend + 5;

        // Dynamic Y start for product
        let yStart = Math.max(receiverBottom, senderBottom) + 5;

        // Detail Produk
        doc.fontSize(8).font("Helvetica-Bold").fillColor("#1d4ed8").text("Detail Produk", 20, yStart);
        yStart += 10;
        doc.roundedRect(20, yStart, 205, hAddr + 20, 4).strokeColor("#d1d5db").stroke();
        let y = yStart + 5;
        itemsList.forEach((item) => {
          doc.fontSize(10).font("Helvetica-Bold").fillColor("#000").text(item.product_name, 25, y, { width: 150 });
          if (item.variant_name) {
            doc.fontSize(8).font("Helvetica").fillColor("#6b7280").text(item.variant_name, 25, y + 10, { width: 150 });
          }
          doc.fontSize(10).font("Helvetica-Bold").fillColor("#000").text(`x ${item.quantity}`, 175, y, { align: "right", width: 45 });
          y += item.variant_name ? 25 : 15;
        });

        // Prices
        doc.roundedRect(20, 270, 95, 30, 4).fillColor("#dbeafe").fill();
        doc.fontSize(8).fillColor("#1d4ed8").text("Total Harga", 25, 275);
        doc.fontSize(10).font("Helvetica-Bold").fillColor("#1e40af").text(`Rp ${order.total_price.toLocaleString()}`, 25, 285);
        doc.roundedRect(130, 270, 95, 30, 4).fillColor("#dbeafe").fill();
        doc.fontSize(8).fillColor("#1d4ed8").text("Ongkir", 135, 275);
        doc.fontSize(10).font("Helvetica-Bold").fillColor("#1e40af").text(`Rp ${order.delivery_fee?.toLocaleString() || "0"}`, 135, 285);

        // Footer
        doc.moveTo(20, 310).lineTo(232, 310).dash(5, { space: 5 }).lineWidth(1).strokeColor("#93c5fd").stroke();
        doc.fontSize(8).fillColor("#6b7280").text(new Date(order.created_at).toLocaleDateString("id-ID"), 20, 315);
        if (qrCode) {
          doc.image(qrCode, 178, 315, { width: 50, height: 50 });
          doc.fontSize(8).fillColor("#6b7280").text("Scan QR", 178, 370, { align: "center", width: 50 });
        }

        doc.end();
      });
    };

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

    // Update terjual batch jika order diterima
    if (newStatus === "diterima") {
      const { error: rpcError } = await supabase.rpc("increment_terjual", {
        order_id_input: orderId,
      });
      if (rpcError) console.error("⚠ Gagal update terjual batch:", rpcError.message);
    }

    const productDetails = buildProductDetails(orderItems, products, variants);

    // Generate PDF if pickup_method "diambil" and new_status "sedang di kemas" or "diterima"
    let pdfBuffer = null;
    if ((newStatus === "sedang di kemas" || newStatus === "diterima") && order.pickup_method === "diambil") {
      pdfBuffer = await generatePDF(updatedOrder);
    }

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
      pdfBuffer,
    }).catch((err) => console.error("❌ Gagal kirim notifikasi:", err));

    // ✅ Response cepat
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