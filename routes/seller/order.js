// routes/seller/order.js
const express = require("express");
const supabase = require("../../config/supabase");
const axios = require("axios");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const router = express.Router();

const SEND_URL = process.env.SEND_SERVICE_URL;
const CRYPTO_SECRET_KEY = process.env.CRYPTO_SECRET_KEY || "please_set_a_real_secret_in_env";

const NodeCache = require("node-cache");
const orderCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
const crypto = require("crypto");
const { DateTime } = require("luxon");

// -----------------------------
// Helper crypto utilities (sama dengan checkout)
// -----------------------------
function signPayload(payload) {
  const stableStringify = (obj) => {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",")}}`;
  };
  const str = stableStringify(payload);
  return crypto.createHmac("sha256", CRYPTO_SECRET_KEY).update(str).digest("hex");
}

// -----------------------------
// Helper DB wallet operations (sama dengan checkout)
// -----------------------------
async function getSellerBalance(sellerId) {
  const { data, error } = await supabase
    .from("seller_balances")
    .select("balance, withdrawable_balance")
    .eq("seller_id", sellerId)
    .single();

  if (error && error.code === "PGRST116") {
    return { balance: 0, withdrawable_balance: 0 };
  }
  if (error) throw error;
  return { 
    balance: Number(data?.balance ?? 0), 
    withdrawable_balance: Number(data?.withdrawable_balance ?? 0) 
  };
}

async function recordSellerTransaction({ sellerId, amount, type, orderId = null, metadata = {} }) {
  const timestamp = DateTime.now().toISO();
  const payloadToSign = { sellerId, amount, type, orderId, metadata, timestamp };
  const signature = signPayload(payloadToSign);

  const insertObj = {
    seller_id: sellerId,
    amount,
    type,
    order_id: orderId,
    timestamp,
    signature,
    metadata,
  };

  const { data, error } = await supabase.from("seller_balance_transactions").insert([insertObj]).select().single();
  if (error) throw error;
  return data;
}


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


// -----------------------------
// Update order status route
// -----------------------------
router.put("/orders/:id/status", async (req, res) => {
  const startTime = Date.now();
  console.log(`===== 📦 [UPDATE ORDER STATUS] Order ID: ${req.params.id} =====`);
  
  try {
    // Parse seller info safely
    let sellerInfo;
    try {
      sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
      console.log("👤 Seller Info:", sellerInfo);
    } catch (err) {
      console.error("❌ Invalid seller info:", err.message);
      return res.status(401).json({ message: "❌ Invalid seller info in cookies." });
    }

    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const orderId = req.params.id;
    const { action, barcodeId } = req.body;

    if (!action) {
      return res.status(400).json({ message: "⚠️ Aksi tidak boleh kosong." });
    }

    // ===== Helper Functions =====
    const fetchOrder = async () => {
      const cacheKey = `order:${orderId}-${sellerInfo.id}`;
      let order = orderCache.get(cacheKey);
      
      if (!order) {
        const { data, error } = await supabase
          .from("orders")
          .select(`
            *,
            buyer:users(nama_penerima, no_telepon, email, username),
            seller:sellers(
              id, email, store_name,
              latitude, longitude,
              store_address, kelurahan, kecamatan, kabupaten, provinsi
            )
          `)
          .eq("id", orderId)
          .eq("seller_id", sellerInfo.id)
          .single();
        
        if (error || !data) {
          console.error("❌ Order fetch error:", error?.message);
          throw new Error("Order not found or access denied");
        }
        order = data;
        orderCache.set(cacheKey, order, 30);
      }
      
      return order;
    };

    const fetchOrderItems = async () => {
      const cacheKey = `order-items:${orderId}`;
      let items = orderCache.get(cacheKey);
      
      if (!items) {
        const { data, error } = await supabase
          .from("order_items")
          .select("id, quantity, price_per_item, product_id, variant_id")
          .eq("order_id", orderId);
        if (error) throw new Error("Failed to fetch order items");
        items = data || [];
        orderCache.set(cacheKey, items, 30);
      }
      
      return items;
    };

    const fetchProductDetails = async (items) => {
      if (!items.length) return [];
      
      const productIds = [...new Set(items.map(i => i.product_id))];
      const variantIds = items.map(i => i.variant_id).filter(Boolean);
      
      const [productsRes, variantsRes] = await Promise.all([
        supabase.from("products").select("id, product_name, product_image_url").in("id", productIds),
        variantIds.length ? supabase.from("product_variants").select("id, variant_name, variant_image_url").in("id", variantIds) : { data: [] }
      ]);
      
      if (productsRes.error) throw new Error("Failed to fetch products");
      
      const products = productsRes.data || [];
      const variants = variantsRes.data || [];
      
      return items.map(item => {
        const product = products.find(p => p.id === item.product_id);
        const variant = variants.find(v => v.id === item.variant_id);
        return {
          product_name: product?.product_name || "Unknown Product",
          variant_name: variant?.variant_name || null,
          quantity: item.quantity,
          total_price: item.price_per_item * item.quantity,
          product_image_url: variant?.variant_image_url || product?.product_image_url,
        };
      });
    };

    const determineNewStatus = (order, action, barcodeId) => {
      const now = DateTime.now().setZone("Asia/Jakarta");
      const payload = {};
      let status = "";

      const commonActions = {
        accept: () => {
          status = "sedang di kemas";
          payload.confirm_deadline = null;
        },
        cancel: () => {
          status = "dibatalkan";
          payload.cancel_reason = "❌ Dibatalkan oleh seller.";
          // Jika cancel sebelum payment confirmed, refund jika perlu
          if (order.payment_status === "paid") {
            payload.refund_requested = true;
          }
        },
      };

      if (commonActions[action]) {
        commonActions[action]();
      } else if (order.pickup_method === "diambil") {
        if (action === "ready") {
          status = "siap di ambil";
          payload.pickup_deadline = now.plus({ hours: 12 }).toISO();
        } else if (action === "complete") {
          if (barcodeId && barcodeId !== orderId.toString()) {
            throw new Error("⚠️ Barcode ID tidak valid untuk order ini.");
          }
          status = "diterima";
          payload.confirm_by_buyers_deadline = now.plus({ hours: 5 }).toISO();
          // 🚨 CRITICAL: Saat diterima, move balance dari holding ke withdrawable
          payload.order_completed = true;
        }
      } else if (order.pickup_method === "diantar") {
        if (action === "ship") {
          status = "sedang di antar";
          payload.delivery_deadline = now.plus({ hours: 12 }).toISO();
          payload.awb_number = req.body.awb_number || null; // Optional AWB
        } else if (action === "complete") {
          status = "diterima";
          payload.confirm_by_buyers_deadline = now.plus({ hours: 5 }).toISO();
          // 🚨 CRITICAL: Saat diterima, move balance dari holding ke withdrawable
          payload.order_completed = true;
        }
      }

      if (!status) {
        throw new Error(`⚠️ Aksi '${action}' tidak valid untuk pickup method '${order.pickup_method}'.`);
      }

      return { status, payload };
    };

    const validateStatusFlow = (current, next) => {
      const statusFlow = {
        pending: ["sedang di kemas", "dibatalkan"],
        "sedang di kemas": ["siap di ambil", "sedang di antar", "dibatalkan"],
        "siap di ambil": ["diterima", "dibatalkan"],
        "sedang di antar": ["diterima", "dibatalkan"],
      };
      return statusFlow[current]?.includes(next) || false;
    };

    // ===== Generate PDF Function (untuk pickup sendiri) =====
    const generatePDF = async (order, productDetails) => {
      try {
        const qrData = JSON.stringify({
          orderId: order.id,
          sellerId: sellerInfo.id,
          timestamp: order.updated_at,
        });
        const qrCode = await QRCode.toDataURL(qrData, { width: 100 });

        let logoBuffer;
        try {
          const logoUrl = "https://hihfiptclwrwuklojdec.supabase.co/storage/v1/object/public/store-photos/BG-Logo-Aplikasi.png";
          const response = await axios.get(logoUrl, { responseType: "arraybuffer" });
          logoBuffer = Buffer.from(response.data);
        } catch (err) {
          console.warn("⚠️ Failed to fetch logo, using without logo");
        }

        // Parse addresses safely
        let buyerAddress = {};
        let sellerAddress = {};
        try {
          buyerAddress = typeof order.buyer_address === "string" 
            ? JSON.parse(order.buyer_address) 
            : (order.buyer_address || {});
          sellerAddress = {
            store_address: order.seller.store_address,
            kelurahan: order.seller.kelurahan,
            kecamatan: order.seller.kecamatan,
            kabupaten: order.seller.kabupaten,
            provinsi: order.seller.provinsi,
          };
        } catch (err) {
          console.error("Failed to parse addresses:", err.message);
        }

        const buyerFullAddress = [
          buyerAddress.alamat_lengkap,
          buyerAddress.kelurahan,
          buyerAddress.kecamatan,
          buyerAddress.kota_kabupaten,
          buyerAddress.provinsi,
          buyerAddress.kode_pos,
        ].filter(Boolean).join(", ");

        const sellerFullAddress = [
          sellerAddress.store_address,
          sellerAddress.kelurahan,
          sellerAddress.kecamatan,
          sellerAddress.kabupaten,
          sellerAddress.provinsi,
        ].filter(Boolean).join(", ");

        return new Promise((resolve, reject) => {
          const doc = new PDFDocument({ size: [252, 400], margin: 10 });
          const buffers = [];
          doc.on("data", buffers.push.bind(buffers));
          doc.on("end", () => resolve(Buffer.concat(buffers)));
          doc.on("error", reject);

          // Border
          doc.lineWidth(1).rect(18, 18, 216, 360).strokeColor("#d1d5db").stroke();

          // Header
          let yPos = 20;
          if (logoBuffer) {
            doc.image(logoBuffer, 20, yPos, { width: 30, height: 30 });
            yPos += 35;
          }
          doc.fontSize(14).font("Helvetica-Bold").fillColor("#1e40af").text("SHIPPING LABEL", 55, yPos);
          yPos += 17;
          doc.fontSize(8).font("Helvetica").fillColor("#6b7280").text(`Order ID: ${order.id}`, 55, yPos);
          yPos += 17;

          // Pickup Method Badge
          doc.roundedRect(180, 20, 50, 20, 4).fillColor("#dbeafe").fill();
          doc.fontSize(9).font("Helvetica-Bold").fillColor("#1e40af").text(
            order.pickup_method.toUpperCase(), 185, 28, { align: "center", width: 40 }
          );

          doc.moveTo(20, yPos + 5).lineTo(232, yPos + 5).lineWidth(1).strokeColor("#d1d5db").stroke();
          yPos += 15;

          // Receiver (untuk pickup sendiri, ini adalah instruksi toko)
          doc.fontSize(9).font("Helvetica-Bold").fillColor("#1d4ed8").text("Toko Pengambilan", 20, yPos);
          yPos += 12;
          doc.fontSize(10).font("Helvetica-Bold").fillColor("#000").text(
            order.seller.store_name || "Toko Seller", 25, yPos, { width: 200 }
          );
          yPos += 12;
          const addrHeight = doc.heightOfString(sellerFullAddress, { width: 200 });
          doc.fontSize(7).font("Helvetica").text(sellerFullAddress, 25, yPos, { width: 200 });
          yPos += addrHeight + 8;

          // Product Details
          doc.fontSize(9).font("Helvetica-Bold").fillColor("#1d4ed8").text("Daftar Produk", 20, yPos);
          yPos += 12;
          
          doc.roundedRect(20, yPos, 205, 80, 4).strokeColor("#d1d5db").stroke();
          let itemY = yPos + 5;
          
          productDetails.slice(0, 3).forEach((item, index) => { // Max 3 items
            if (itemY > yPos + 75) return; // Prevent overflow
            
            const lineHeight = item.variant_name ? 20 : 14;
            if (itemY + lineHeight > yPos + 75) return;
            
            doc.fontSize(8).font("Helvetica-Bold").fillColor("#000").text(
              item.product_name, 25, itemY, { width: 140 }
            );
            if (item.variant_name) {
              doc.fontSize(7).font("Helvetica").fillColor("#6b7280").text(
                item.variant_name, 25, itemY + 10, { width: 140 }
              );
            }
            doc.fontSize(8).font("Helvetica-Bold").fillColor("#000").text(
              `x${item.quantity}`, 175, itemY, { align: "right", width: 45 }
            );
            itemY += lineHeight + 2;
          });

          yPos += 95;

          // Prices
          if (yPos + 60 < 350) {
            doc.roundedRect(20, yPos, 95, 25, 4).fillColor("#dbeafe").fill();
            doc.fontSize(7).fillColor("#1d4ed8").text("Total Harga", 25, yPos + 5);
            doc.fontSize(9).font("Helvetica-Bold").fillColor("#1e40af").text(
              `Rp ${Number(order.total_price).toLocaleString()}`, 25, yPos + 12
            );

            if (order.delivery_fee > 0) {
              doc.roundedRect(130, yPos, 95, 25, 4).fillColor("#dbeafe").fill();
              doc.fontSize(7).fillColor("#1d4ed8").text("Ongkir", 135, yPos + 5);
              doc.fontSize(9).font("Helvetica-Bold").fillColor("#1e40af").text(
                `Rp ${Number(order.delivery_fee).toLocaleString()}`, 135, yPos + 12
              );
            }
            yPos += 35;
          }

          // Footer & QR
          doc.moveTo(20, Math.max(yPos, 310)).lineTo(232, Math.max(yPos, 310))
             .dash(5, { space: 5 }).lineWidth(1).strokeColor("#93c5fd").stroke();
          
          const footerY = Math.max(yPos + 5, 315);
          doc.fontSize(8).fillColor("#6b7280").text(
            `Dicetak: ${DateTime.now().setZone("Asia/Jakarta").toFormat("dd MMM yyyy HH:mm")}`, 
            20, footerY
          );

          if (qrCode && footerY + 55 < 380) {
            doc.image(qrCode, 178, footerY, { width: 50, height: 50 });
            doc.fontSize(7).fillColor("#6b7280").text(
              "Scan QR untuk\nverifikasi", 178, footerY + 55, { align: "center", width: 50 }
            );
          }

          doc.end();
        });
      } catch (err) {
        console.error("❌ PDF Generation error:", err.message);
        throw err;
      }
    };

    // ===== MAIN FLOW =====
    console.log(`🔄 Fetching order ${orderId}...`);
    const order = await fetchOrder();
    console.log(`✅ Order found: ${order.status} → ${action}`);

    const orderItems = await fetchOrderItems();
    const productDetails = await fetchProductDetails(orderItems);

    let newStatus, updatePayload;
    try {
      const result = determineNewStatus(order, action, barcodeId);
      newStatus = result.status;
      updatePayload = result.payload;
      console.log(`🎯 Determined new status: ${newStatus}`);
    } catch (err) {
      console.error("❌ Status determination error:", err.message);
      return res.status(400).json({ message: err.message });
    }

    if (!newStatus) {
      return res.status(400).json({ message: "⚠️ Aksi tidak valid untuk order ini." });
    }

    if (order.status === newStatus) {
      return res.status(200).json({
        message: `⚠️ Order sudah dalam status '${newStatus}'.`,
        order,
      });
    }

    if (!validateStatusFlow(order.status, newStatus)) {
      return res.status(400).json({
        message: `⚠️ Tidak bisa berpindah dari '${order.status}' ke '${newStatus}' secara langsung.`,
      });
    }

    // Prepare update payload
    updatePayload.status = newStatus;
    updatePayload.updated_at = DateTime.now().setZone("Asia/Jakarta").toISO();
    
    // Seller address for delivery
    updatePayload.seller_address = {
      store_name: order.seller.store_name,
      store_address: order.seller.store_address,
      kelurahan: order.seller.kelurahan,
      kecamatan: order.seller.kecamatan,
      kabupaten: order.seller.kabupaten,
      provinsi: order.seller.provinsi,
      latitude: order.seller.latitude,
      longitude: order.seller.longitude,
    };

    console.log(`💾 Updating order status to: ${newStatus}`);
    const { data: updatedOrder, error: updateError } = await supabase
      .from("orders")
      .update(updatePayload)
      .eq("id", orderId)
      .select(`
        *,
        buyer:users(nama_penerima, no_telepon, email, username),
        seller:sellers(id, email, store_name)
      `)
      .single();

    if (updateError || !updatedOrder) {
      console.error("❌ Update error:", updateError?.message);
      return res.status(500).json({ message: "❌ Gagal update status order." });
    }

    // Update terjual batch jika order diterima
    if (newStatus === "diterima") {
      try {
        const { error: rpcError } = await supabase.rpc("increment_terjual", {
          order_id_input: orderId,
        });
        if (rpcError) {
          console.warn("⚠️ Gagal update terjual:", rpcError.message);
        } else {
          console.log("✅ Updated terjual count");
        }
      } catch (rpcErr) {
        console.error("❌ RPC error:", rpcErr.message);
      }

      // 🚨 CRITICAL: Handle wallet balance movement saat order completed
      await handleOrderCompletion(sellerInfo.id, orderId, updatedOrder);
    }

    // Invalidate cache
    orderCache.del([`order:${orderId}-${sellerInfo.id}`, `order-items:${orderId}`]);

    // Generate PDF if needed (hanya untuk pickup sendiri)
    let pdfBuffer = null;
    let pdfBase64 = null;
    if (newStatus === "siap di ambil" && order.pickup_method === "diambil") {
      try {
        console.log("📄 Generating PDF for pickup...");
        pdfBuffer = await generatePDF(updatedOrder, productDetails);
        pdfBase64 = pdfBuffer.toString('base64');
        console.log("✅ PDF generated successfully");
      } catch (pdfErr) {
        console.error("❌ PDF generation failed:", pdfErr.message);
      }
    }

    // 🚀 Background: Kirim notifikasi email
    (async () => {
      try {
        await axios.post(`${SEND_URL}/send-email-order`, {
          order_id: orderId,
          products: productDetails,
          buyer_email: updatedOrder.buyer?.email,
          seller_email: updatedOrder.seller.email,
          buyer_username: updatedOrder.buyer?.username,
          seller_username: sellerInfo.username,
          pickup_method: order.pickup_method,
          new_status: newStatus,
          seller_address: updatePayload.seller_address,
          cancel_reason: updatePayload.cancel_reason || null,
          pdf_base64: pdfBase64, // Kirim sebagai base64 untuk attachment
          ...(newStatus === "diterima" && { balance_notification: true }),
        });
        console.log("📧 Email notification sent");
      } catch (emailErr) {
        console.error("❌ Failed to send email:", emailErr.response?.data || emailErr.message);
      }
    })();

    const endTime = Date.now();
    const processingTime = ((endTime - startTime) / 1000).toFixed(2);

    console.log(`✅ Status updated to '${newStatus}' in ${processingTime}s`);

    return res.status(200).json({
      message: `✅ Status order berhasil diubah ke '${newStatus}'`,
      order: updatedOrder,
      processing_time: `${processingTime}s`,
      ...(pdfBase64 && { pdf_available: true }),
    });

  } catch (err) {
    console.error("❌ Server Error:", err);
    const endTime = Date.now();
    console.error(`⏱ Total time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server.",
      error: process.env.NODE_ENV === 'development' ? err.message : "Internal server error",
    });
  }
});

// -----------------------------
// Handle Order Completion - Move balance to withdrawable
// -----------------------------
async function handleOrderCompletion(sellerId, orderId, order) {
  try {
    console.log(`💰 Processing balance movement for completed order ${orderId}`);
    
    // Ambil current balance
    const currentBalance = await getSellerBalance(sellerId);
    console.log(
      `💳 Current balance - Total: ${currentBalance.balance}, Withdrawable: ${currentBalance.withdrawable_balance}`
    );
    
    // Hitung net amount to seller (tanpa platform fee)
    const grossAmount = Number(order.total_price || 0);
    const netToSeller = grossAmount;
    
    console.log(`💸 Distribution - Gross: ${grossAmount}, Net: ${netToSeller}`);
    
    // Simulasi: asumsikan sebelumnya sudah di-credit ke total balance saat payment confirmed
    // Sekarang kita move dari total ke withdrawable
    const newTotalBalance = currentBalance.balance; // Tetap sama
    const newWithdrawableBalance = currentBalance.withdrawable_balance + netToSeller;
    
    // Update balances
    const { data: balanceData, error: balanceError } = await supabase
      .from("seller_balances")
      .update({ 
        balance: newTotalBalance,
        withdrawable_balance: newWithdrawableBalance 
      })
      .eq("seller_id", sellerId)
      .select()
      .single();
    
    if (balanceError) throw balanceError;
    
    // Record transaction
    await recordSellerTransaction({
      sellerId,
      amount: netToSeller,
      type: "move_to_withdrawable",
      orderId,
      metadata: { 
        source: "order_completed", 
        grossAmount,
        action: "released_to_withdrawable"
      },
    });
    
    console.log(
      `✅ Balance moved: +${netToSeller} to withdrawable. New withdrawable: ${newWithdrawableBalance}`
    );
    
  } catch (balanceErr) {
    console.error("❌ Balance movement error:", balanceErr.message);
    // Jangan throw - biarkan order tetap completed
  }
}

// -----------------------------
// Get Seller Balance
// -----------------------------
router.get("/balance", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const balance = await getSellerBalance(sellerInfo.id);
    const transactions = await supabase
      .from("seller_balance_transactions")
      .select("*, order:orders!inner(id, status, total_price, created_at)")
      .eq("seller_id", sellerInfo.id)
      .order("timestamp", { ascending: false })
      .limit(10);

    return res.status(200).json({
      balance: {
        total: balance.balance,
        withdrawable: balance.withdrawable_balance,
        pending: balance.balance - balance.withdrawable_balance,
      },
      recent_transactions: transactions.data || [],
    });

  } catch (err) {
    console.error("❌ Get balance error:", err.message);
    return res.status(500).json({ message: "❌ Gagal mengambil data balance." });
  }
});

module.exports = router;