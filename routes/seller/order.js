
// routes/seller/order.js
const express = require("express");
const supabase = require("../../config/supabase");
const axios = require("axios");
const router = express.Router();

const CRYPTO_SECRET_KEY = process.env.CRYPTO_SECRET_KEY || "please_set_a_real_secret_in_env";

const NodeCache = require("node-cache");
const orderCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
const crypto = require("crypto");
const { DateTime } = require("luxon");

// Helper crypto utilities
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

// ======= Helper Aman JSON ======= //
function safeParseJSON(str, fallback = []) {
  if (!str) return fallback;
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return [str];
  }
}


// Helper DB wallet operations for sellers
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
    withdrawable_balance: Number(data?.withdrawable_balance ?? 0),
  };
}

async function upsertSellerBalance(sellerId, newBalance) {
  const { data, error } = await supabase
    .from("seller_balances")
    .upsert({ seller_id: sellerId, balance: newBalance }, { onConflict: "seller_id" })
    .select()
    .single();
  if (error) throw error;
  return data;
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

  const { data, error } = await supabase
    .from("seller_balance_transactions")
    .insert([insertObj])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function withdrawSellerBalance(sellerId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getSellerBalance(sellerId);
  if (Number(current.balance) < Number(amount)) {
    throw new Error("Insufficient funds");
  }
  const newBalance = Number(current.balance) - Number(amount);
  await upsertSellerBalance(sellerId, newBalance);
  await recordSellerTransaction({
    sellerId,
    amount,
    type: "debit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
}

// Helper DB wallet operations for users
async function getUserBalance(userId) {
  const { data, error } = await supabase
    .from("user_balances")
    .select("balance")
    .eq("user_id", userId)
    .single();

  if (error && error.code === "PGRST116") {
    return 0;
  }
  if (error) throw error;
  return Number(data?.balance ?? 0);
}

async function upsertUserBalance(userId, newBalance) {
  const { data, error } = await supabase
    .from("user_balances")
    .upsert({ user_id: userId, balance: newBalance }, { onConflict: "user_id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function recordUserTransaction({ userId, amount, type, orderId = null, metadata = {} }) {
  const timestamp = DateTime.now().toISO();
  const payloadToSign = { userId, amount, type, orderId, metadata, timestamp };
  const signature = signPayload(payloadToSign);

  const insertObj = {
    user_id: userId,
    amount,
    type,
    order_id: orderId,
    timestamp,
    signature,
    metadata,
  };

  const { data, error } = await supabase
    .from("user_balance_transactions")
    .insert([insertObj])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function mintUserBalance(userId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getUserBalance(userId);
  const newBalance = Number(current) + Number(amount);
  await upsertUserBalance(userId, newBalance);
  await recordUserTransaction({
    userId,
    amount,
    type: "credit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
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
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address, payment_status, payment_channel")
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
        } catch {
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
        } catch {
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
        can_process: order.payment_status === "paid" || order.payment_channel === "cod" || order.payment_channel === "balance"
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
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address, payment_status, payment_channel")
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
        } catch {
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
        } catch {
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
        can_process: order.payment_status === "paid" // true if paid, false if pending or other
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
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address, payment_status, payment_channel")
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
        } catch {
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
        } catch {
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
        can_process: order.payment_status === "paid" // true if paid, false if pending or other
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
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address, payment_status, payment_channel")
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
      } catch {
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
      } catch {
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
      can_process: orderData.payment_status === "paid" || orderData.payment_channel === "cod" || orderData.payment_channel === "balance"
    };

    orderCache.set(cacheKey, orderResult);
    return res.status(200).json({ message: "✅ Detail order seller berhasil diambil.", order: orderResult });
  } catch (err) {
    console.error("❌ Server error (seller/:orderId):", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

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

    // Helper Functions
    const fetchOrder = async () => {
      const cacheKey = `order:${orderId}-${sellerInfo.id}`;
      let order = orderCache.get(cacheKey);

      if (!order) {
        const { data, error } = await supabase
          .from("orders")
          .select(`
            *,
            buyer:users(id, nama_penerima, no_telepon, email, username),
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
          .select("id, quantity, price_per_item, product_id, variant_id, discount_source")
          .eq("order_id", orderId);
        if (error) throw new Error("Failed to fetch order items");
        items = data || [];
        orderCache.set(cacheKey, items, 30);
      }

      return items;
    };

    const fetchProductDetails = async (items) => {
      if (!items.length) return [];

      const productIds = [...new Set(items.map((i) => i.product_id))];
      const variantIds = items.map((i) => i.variant_id).filter(Boolean);

      const [productsRes, variantsRes] = await Promise.all([
        supabase.from("products").select("id, product_name, product_image_url, stock").in("id", productIds),
        variantIds.length
          ? supabase.from("product_variants").select("id, variant_name, variant_image_url, variant_stock").in("id", variantIds)
          : { data: [] },
      ]);

      if (productsRes.error) throw new Error("Failed to fetch products");

      const products = productsRes.data || [];
      const variants = variantsRes.data || [];

      return items.map((item) => {
        const product = products.find((p) => p.id === item.product_id);
        const variant = variants.find((v) => v.id === item.variant_id);
        return {
          product_name: product?.product_name || "Unknown Product",
          variant_name: variant?.variant_name || null,
          quantity: item.quantity,
          total_price: item.price_per_item * item.quantity,
          product_image_url: variant?.variant_image_url || safeParseJSON(product?.product_image_url)?.[0] || product?.product_image_url || null,
          discount_source: item.discount_source,
        };
      });
    };

      const restoreStock = async (orderItems) => {
  console.log(`🔄 Starting stock restoration for ${orderItems.length} items...`);
  for (const item of orderItems) {
    const { discount_source, quantity, product_id, variant_id } = item;

    // Parse discount_source JSONB
    const source = discount_source?.source || "normal";
    const sourceId = discount_source?.id || null;

    console.log(`📦 Restoring stock for item: product=${product_id}, variant=${variant_id || 'none'}, source=${source}, qty=${quantity}`);

    try {
      if (source === "flash_sale") {
        console.log(`🔄 Fetching flash sale stock for ${sourceId}...`);
        // Fetch current flash sale stock (tetep sama)
        let query = supabase
          .from("flash_sale_products")
          .select("flash_stock")
          .eq("id", sourceId)
          .eq("product_id", product_id);

        if (variant_id) {
          query = query.eq("variant_id", variant_id);
        } else {
          query = query.is("variant_id", null);
        }

        const { data: flashData, error: fetchError } = await query.single();
        if (fetchError || !flashData) {
          throw new Error(`Failed to fetch flash sale stock: ${fetchError?.message}`);
        }

        const newStock = (flashData.flash_stock || 0) + quantity;

        console.log(`💾 Updating flash sale stock to ${newStock}...`);
        // FIXED: Chain eq/is berdasarkan variant_id
        let updateQuery = supabase
          .from("flash_sale_products")
          .update({ flash_stock: newStock })
          .eq("id", sourceId)
          .eq("product_id", product_id);

        if (variant_id) {
          updateQuery = updateQuery.eq("variant_id", variant_id);
        } else {
          updateQuery = updateQuery.is("variant_id", null);
        }

        const { error: updateError } = await updateQuery;
        if (updateError) throw new Error(`Failed to restore flash sale stock: ${updateError.message}`);
        console.log(
          `✅ Restored ${quantity} to flash sale stock for product ${product_id}, variant ${variant_id || "none"}, flash_sale_id ${sourceId}`
        );
      } else if (source === "event") {
        console.log(`🔄 Fetching event stock for ${sourceId}...`);
        // Fetch current event stock (tetep sama)
        let query = supabase
          .from("event_products")
          .select("event_stock")
          .eq("id", sourceId)
          .eq("product_id", product_id);

        if (variant_id) {
          query = query.eq("variant_id", variant_id);
        } else {
          query = query.is("variant_id", null);
        }

        const { data: eventData, error: fetchError } = await query.single();
        if (fetchError || !eventData) {
          throw new Error(`Failed to fetch event stock: ${fetchError?.message}`);
        }

        const newStock = (eventData.event_stock || 0) + quantity;

        console.log(`💾 Updating event stock to ${newStock}...`);
        // FIXED: Chain eq/is berdasarkan variant_id
        let updateQuery = supabase
          .from("event_products")
          .update({ event_stock: newStock })
          .eq("id", sourceId)
          .eq("product_id", product_id);

        if (variant_id) {
          updateQuery = updateQuery.eq("variant_id", variant_id);
        } else {
          updateQuery = updateQuery.is("variant_id", null);
        }

        const { error: updateError } = await updateQuery;
        if (updateError) throw new Error(`Failed to restore event stock: ${updateError.message}`);
        console.log(
          `✅ Restored ${quantity} to event stock for product ${product_id}, variant ${variant_id || "none"}, event_id ${sourceId}`
        );
      } else if (source === "store_discount") {
        console.log(`🔄 Fetching store discount stock for ${sourceId}...`);
        // Fetch current store discount stock (tetep sama)
        let query = supabase
          .from("store_discount_items")
          .select("stock")
          .eq("id", sourceId)
          .eq("product_id", product_id);

        if (variant_id) {
          query = query.eq("variant_id", variant_id);
        } else {
          query = query.is("variant_id", null);
        }

        const { data: discountData, error: fetchError } = await query.single();
        if (fetchError || !discountData) {
          throw new Error(`Failed to fetch store discount stock: ${fetchError?.message}`);
        }

        const newStock = (discountData.stock || 0) + quantity;

        console.log(`💾 Updating store discount stock to ${newStock}...`);
        // FIXED: Chain eq/is berdasarkan variant_id
        let updateQuery = supabase
          .from("store_discount_items")
          .update({ stock: newStock })
          .eq("id", sourceId)
          .eq("product_id", product_id);

        if (variant_id) {
          updateQuery = updateQuery.eq("variant_id", variant_id);
        } else {
          updateQuery = updateQuery.is("variant_id", null);
        }

        const { error: updateError } = await updateQuery;
        if (updateError) throw new Error(`Failed to restore store discount stock: ${updateError.message}`);
        console.log(
          `✅ Restored ${quantity} to store discount stock for product ${product_id}, variant ${variant_id || "none"}, store_discount_id ${sourceId}`
        );
      } else {
            // Restore to normal stock
            if (variant_id) {
              const { data: variant, error: fetchError } = await supabase
                .from("product_variants")
                .select("variant_stock")
                .eq("id", variant_id)
                .single();
              if (fetchError || !variant) {
                throw new Error(`Failed to fetch variant for stock restoration: ${fetchError?.message}`);
              }

              const newStock = (variant.variant_stock || 0) + quantity;
              const { error: updateError } = await supabase
                .from("product_variants")
                .update({ variant_stock: newStock })
                .eq("id", variant_id);
              if (updateError) {
                throw new Error(`Failed to restore variant stock: ${updateError.message}`);
              }
              console.log(`✅ Restored ${quantity} to variant stock ${variant_id}`);
            } else {
              const { data: product, error: fetchError } = await supabase
                .from("products")
                .select("stock")
                .eq("id", product_id)
                .single();
              if (fetchError || !product) {
                throw new Error(`Failed to fetch product for stock restoration: ${fetchError?.message}`);
              }

              const newStock = (product.stock || 0) + quantity;
              const { error: updateError } = await supabase
                .from("products")
                .update({ stock: newStock })
                .eq("id", product_id);
              if (updateError) {
                throw new Error(`Failed to restore product stock: ${updateError.message}`);
              }
              console.log(`✅ Restored ${quantity} to product stock ${product_id}`);
            }
          }
        } catch (error) {
      console.error(
        `❌ Failed to restore stock for item (product_id: ${product_id}, variant_id: ${
          variant_id || "none"
        }, source: ${source}): ${error.message}`
      );
      throw error; // Re-throw to trigger transaction rollback
    }
  }
  console.log(`✅ Completed stock restoration for all items`);
    };

    const determineNewStatus = ( order, action ) => {
      const now = DateTime.now().setZone("Asia/Jakarta");
      const payload = {};
      let status = "";

      const commonActions = {
        accept: () => {
          if (
            (order.payment_method === "digital" || order.payment_method === "balance") &&
            order.status !== "processing" && order.payment_status !== "paid"
          ) {
            throw new Error(
              "⚠️ Order dengan pembayaran digital atau balance hanya bisa diterima dari status 'paid'."
            );
          }
          if (order.payment_method === "cod" && order.status !== "pending") {
            throw new Error("⚠️ Order dengan pembayaran COD hanya bisa diterima dari status 'pending'.");
          }
          status = "sedang di kemas";
          payload.confirm_deadline = null;
        },
        cancel: () => {
          status = "dibatalkan";
          payload.cancel_reason = "❌ Dibatalkan oleh seller.";
          if (order.payment_status === "paid" && order.payment_method !== "cod") {
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
          status = "diterima";
          payload.confirm_by_buyers_deadline = now.plus({ hours: 5 }).toISO();
        }
      } else if (order.pickup_method === "diantar") {
        if (action === "ship") {
          status = "sedang di antar";
          payload.delivery_deadline = now.plus({ hours: 12 }).toISO();
        } else if (action === "complete") {
          status = "diterima";
          payload.confirm_by_buyers_deadline = now.plus({ hours: 5 }).toISO();
        }
      }

      if (!status) {
        throw new Error(`⚠️ Aksi '${action}' tidak valid untuk pickup method '${order.pickup_method}'.`);
      }

      return { status, payload };
    };

    const validateStatusFlow = (order, newStatus) => {
      const statusFlow = {
        pending: ["sedang di kemas", "dibatalkan"],
        processing: ["sedang di kemas", "dibatalkan"],
        "sedang di kemas": ["siap di ambil", "sedang di antar", "dibatalkan"],
        "siap di ambil": ["diterima", "dibatalkan"],
        "sedang di antar": ["diterima", "dibatalkan"],
      };
      return statusFlow[order.status]?.includes(newStatus) || false;
    };

    // MAIN FLOW
    console.log(`🔄 Fetching order ${orderId}...`);
    const order = await fetchOrder();
    console.log(`✅ Order found: ${order.status} → ${action}`);

    if (!order.buyer?.id) {
      console.error("❌ Order missing buyer_id:", orderId);
      return res.status(400).json({ message: "❌ Order tidak memiliki informasi pembeli." });
    }

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

    if (!validateStatusFlow(order, newStatus)) {
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
        buyer:users(id, nama_penerima, no_telepon, email, username),
        seller:sellers(id, email, store_name)
      `)
      .single();

    if (updateError || !updatedOrder) {
      console.error("❌ Update error:", updateError?.message);
      return res.status(500).json({ message: "❌ Gagal update status order.", error: updateError?.message });
    }

    // Handle balance movement if order is completed (status: diterima)
    if (newStatus === "diterima") {
      await handleOrderCompletion(updatedOrder.seller.id, orderId, updatedOrder);
    }

    // Handle refund and stock restoration if canceled
    if (newStatus === "dibatalkan" && updatedOrder.payment_status === "paid" && updatedOrder.payment_method !== "cod") {
      const grossAmount = Number(updatedOrder.total_price ?? 0);
      const platformFee = 0; // Sesuaikan jika ada fee
      const netAmount = grossAmount - platformFee;

      if (netAmount <= 0) {
        console.warn(`⚠️ Net amount for refund is 0 or negative for order ${orderId}. Skipping refund.`);
      } else {
        try {
          // Debit dari seller balance
          await withdrawSellerBalance(updatedOrder.seller.id, netAmount, {
            orderId: updatedOrder.id,
            metadata: { source: "seller_cancel_refund_debit" },
          });
          console.log(`✅ Debited seller ${updatedOrder.seller.id} amount ${netAmount}`);

          // Credit ke user balance
          await mintUserBalance(updatedOrder.buyer.id, netAmount, {
            orderId: updatedOrder.id,
            metadata: { source: "seller_cancel_refund_credit" },
          });
          console.log(`✅ Credited user ${updatedOrder.buyer.id} amount ${netAmount}`);

          // Update order refund status
          await supabase
            .from("orders")
            .update({
              refund_status: "completed",
              refunded_at: new Date().toISOString(),
              refund_requested: false,
            })
            .eq("id", updatedOrder.id);
          console.log(`✅ Updated refund status for order ${orderId}`);
        } catch (refundErr) {
          console.error(`❌ Refund failed for order ${orderId}:`, refundErr.message);
          await supabase
            .from("orders")
            .update({
              refund_status: "failed",
              refund_requested: true,
            })
            .eq("id", updatedOrder.id);
          return res.status(500).json({ message: "❌ Gagal memproses refund.", error: refundErr.message });
        }
      }
    }

    // Restore stock if canceled
    if (newStatus === "dibatalkan") {
      try {
        await restoreStock(orderItems);
        console.log(`✅ Stock restored for order ${orderId}`);
      } catch (stockErr) {
        console.error(`❌ Stock restoration failed for order ${orderId}:`, stockErr.message);
        return res.status(500).json({ message: "❌ Gagal mengembalikan stok.", error: stockErr.message });
      }
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
    }

    // Invalidate cache
    orderCache.del([`order:${orderId}-${sellerInfo.id}`, `order-items:${orderId}`]);

    // Prepare data for email notification
    const emailPayload = {
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
      total_price: updatedOrder.total_price,
      delivery_fee: updatedOrder.delivery_fee,
      buyer_address: updatedOrder.buyer_address,
      updated_at: updatedOrder.updated_at,
      created_at: updatedOrder.created_at,
      ...(newStatus === "dibatalkan" && updatedOrder.refund_status === "completed" && updatedOrder.payment_method !== "cod" && {
        refund_amount: updatedOrder.total_price,
        refund_status: "completed",
      }),
    };

    // Background: Kirim notifikasi email
    let pdfAvailable = false;
    if ((newStatus === "sedang di kemas" || newStatus === "siap di ambil" || newStatus === "diterima") && order.pickup_method === "diambil") {
      pdfAvailable = true;
    }

    (async () => {
      try {
        console.log("📧 [EMAIL] Preparing to send email notification for order:", orderId);
        console.log("📧 [EMAIL] Email payload:", emailPayload);
        await axios.post(`${process.env.SEND_URL}/send-email-order`, emailPayload);
        console.log("✅ [EMAIL] Email notification request sent successfully");
      } catch (emailErr) {
        console.error("❌ [EMAIL] Failed to send email:", emailErr.response?.data || emailErr.message);
      }
    })();

    const endTime = Date.now();
    const processingTime = ((endTime - startTime) / 1000).toFixed(2);

    console.log(`✅ Status updated to '${newStatus}' in ${processingTime}s`);

    return res.status(200).json({
      message: `✅ Status order berhasil diubah ke '${newStatus}'`,
      order: updatedOrder,
      processing_time: `${processingTime}s`,
      ...(pdfAvailable && { pdf_available: true }),
    });

  } catch (err) {
    console.error("❌ Server Error:", err);
    const endTime = Date.now();
    console.error(`⏱ Total time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server.",
      error: process.env.NODE_ENV === "development" ? err.message : "Internal server error",
    });
  }
});
// Handle Order Completion - Move balance to withdrawable
async function handleOrderCompletion(sellerId, orderId, order) {
  try {
    console.log(`💰 Processing balance movement for completed order ${orderId}`);

    // Kalau payment pakai COD → skip
    if (order.payment_method && order.payment_method.toLowerCase() === "cod") {
      console.log(`⚠️ COD order detected. Skipping balance release for order ${orderId}`);
      return;
    }

    // Ambil current balance seller
    const currentBalance = await getSellerBalance(sellerId);
    console.log(
      `💳 Current balance - Total: ${currentBalance.balance}, Withdrawable: ${currentBalance.withdrawable_balance}`
    );

    // Hitung net amount to seller (tanpa platform fee, fee bisa dipotong di sini kalau ada)
    const grossAmount = Number(order.total_price || 0);
    const netToSeller = grossAmount;

    console.log(`💸 Distribution - Gross: ${grossAmount}, Net: ${netToSeller}`);

    // Sekarang pindahkan ke withdrawable
    const newTotalBalance = currentBalance.balance; // Tetap sama
    const newWithdrawableBalance = currentBalance.withdrawable_balance + netToSeller;

    // Update balances di Supabase
    const { error: balanceError } = await supabase
      .from("seller_balances")
      .update({
        balance: newTotalBalance,
        withdrawable_balance: newWithdrawableBalance,
      })
      .eq("seller_id", sellerId)
      .select()
      .single();

    if (balanceError) throw balanceError;

    // Record transaction ke tabel transaksi
    await recordSellerTransaction({
      sellerId,
      amount: netToSeller,
      type: "move_to_withdrawable",
      orderId,
      metadata: {
        source: "order_completed",
        grossAmount,
        action: "released_to_withdrawable",
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
module.exports = router;