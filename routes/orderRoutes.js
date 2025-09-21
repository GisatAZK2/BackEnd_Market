const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const axios = require("axios");
const { Xendit } = require("xendit-node");
const { DateTime } = require("luxon");
const crypto = require("crypto");
const NodeCache = require("node-cache");
const {
  attachVariantsStockDiscountWithRealDiscount
} = require("../utils/applyDiscountAndVariants");
const {getXenditMode,getXenditChannels, Listpaymentchanel, getXenditInvoice} = require("../utils/listpaymentchanel");

// ==============================
// Environment variables
// ==============================
const SEND_URL = process.env.SEND_SERVICE_URL;
const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;

const FRONTEND_URLS = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(",")
  : ["http://localhost:3000"];
const BASE_URL = FRONTEND_URLS[0];

const CRYPTO_SECRET_KEY =
  process.env.CRYPTO_SECRET_KEY || "please_set_a_real_secret_in_env";

if (!XENDIT_SECRET_KEY) {
  console.warn(
    "⚠️ XENDIT_SECRET_KEY belum diset - invoice creation akan gagal jika dipanggil."
  );
}
if (!CRYPTO_SECRET_KEY) {
  console.warn("⚠️ CRYPTO_SECRET_KEY belum diset - signatures tidak aman.");
}

// ==============================
// Xendit init
// ==============================
const xendit = new Xendit({ secretKey: XENDIT_SECRET_KEY });

const XENDIT_BASE_URL = "https://api.xendit.co";

// Cache setup
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
const orderCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });

const cacheGet = (k) => cache.get(k);
const cacheSet = (k, v, ttlSec = 60) => cache.set(k, v, ttlSec);

// Helper crypto utilities
function signPayload(payload) {
  const stableStringify = (obj) => {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",")}}`;
  };
  const str = stableStringify(payload);
  return crypto.createHmac("sha256", CRYPTO_SECRET_KEY).update(str).digest("hex");
}


// Helper DB wallet operations for sellers
async function getSellerBalance(sellerId) {
  const { data, error } = await supabase
    .from("seller_balances")
    .select("balance")
    .eq("seller_id", sellerId)
    .single();

  if (error && error.code === "PGRST116") {
    return 0;
  }
  if (error) throw error;
  return Number(data?.balance ?? 0);
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

async function mintSellerBalance(sellerId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getSellerBalance(sellerId);
  const newBalance = Number(current) + Number(amount);
  await upsertSellerBalance(sellerId, newBalance);
  await recordSellerTransaction({
    sellerId,
    amount,
    type: "credit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
}
// Helper DB wallet operations for users
async function getUserBalance(userId) {
  const { data, error } = await supabase
    .from("user_balances")
    .select("balance, user_pin_hash, bank_code, account_holder_name, account_number")
    .eq("user_id", userId)
    .single();

  if (error && error.code === "PGRST116") {
    return {
      balance: 0,
      withdrawable_balance: 0,
      user_pin_hash: null,
      bank_code: null,
      account_holder_name: null,
      account_number: null,
    };
  }
  if (error) throw error;
  return {
    balance: Number(data?.balance ?? 0),
    withdrawable_balance: Number(data?.balance ?? 0),
    user_pin_hash: data?.user_pin_hash,
    bank_code: data?.bank_code,
    account_holder_name: data?.account_holder_name,
    account_number: data?.account_number,
  };
}

async function upsertUserBalance(userId, newBalance, newWithdrawableBalance) {
  const { data, error } = await supabase
    .from("user_balances")
    .upsert(
      {
        user_id: userId,
        balance: newBalance,
        withdrawable_balance: newWithdrawableBalance,
      },
      { onConflict: "user_id" }
    )
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
  const newBalance = Number(current.balance) + Number(amount);
  const newWithdrawableBalance = Number(current.balance) + Number(amount);
  await upsertUserBalance(userId, newBalance, newWithdrawableBalance);
  await recordUserTransaction({
    userId,
    amount,
    type: "credit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
}

async function withdrawUserBalance(userId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getUserBalance(userId);
  if (Number(current.withdrawable_balance) < Number(amount)) {
    throw new Error("Insufficient withdrawable funds");
  }
  const newBalance = Number(current.balance) - Number(amount);
  const newWithdrawableBalance = Number(current.withdrawable_balance) - Number(amount);
  await upsertUserBalance(userId, newBalance, newWithdrawableBalance);
  await recordUserTransaction({
    userId,
    amount,
    type: "debit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
}

// Helper function to parse image URLs
function safeParseImageUrl(data) {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed[0];
    }
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return data; // Fallback kalau bukan JSON valid
  }
}

function formatCurrencyNumber(v) {
  return Math.round(Number(v));
}

// ======================
// GET orders dibatalkan
// ======================
router.get("/canceled", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) return res.status(401).json({ message: "❌ Harus login untuk melihat daftar order batal." });

    const cacheKey = `orders:canceled:${userInfo.id}`;
    let cachedOrders = orderCache.get(cacheKey);

    if (cachedOrders) {
      const updatedOrders = await attachRatings(cachedOrders, userInfo.id);
      return res.status(200).json({ message: "✅ Daftar order dibatalkan berhasil diambil.", orders: updatedOrders });
    }

    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address")
      .eq("user_id", userInfo.id)
      .eq("status", "dibatalkan")
      .order("created_at", { ascending: false });

    if (orderError) return res.status(500).json({ message: "❌ Gagal mengambil data order batal.", error: orderError });
    if (!ordersData.length) return res.status(200).json({ message: "✅ Tidak ada order dibatalkan.", orders: [] });

    const orderIds = ordersData.map(o => o.id);
    const [orderItemsRes, detailItemsRes] = await Promise.all([
      supabase.from("order_items").select("id, order_id, product_id, variant_id, quantity").in("order_id", orderIds),
      supabase.from("order_details_items").select("*").in("order_id", orderIds)
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    const orderItemMap = {};
    orderItems.forEach(oi => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      orderItemMap[key] = { id: oi.id, quantity: oi.quantity ?? 0 };
    });

    const qtyByOrder = {};
    orderItems.forEach(item => {
      qtyByOrder[item.order_id] = (qtyByOrder[item.order_id] || 0) + (item.quantity ?? 0);
    });

    const itemsByOrder = {};
    detailItems.forEach(item => {
      const key = `${item.order_id}-${item.product_id}-${item.variant_id ?? "null"}`;
      const entry = orderItemMap[key] || { id: null, quantity: 0 };

      itemsByOrder[item.order_id] = itemsByOrder[item.order_id] || [];
      itemsByOrder[item.order_id].push({
        orderItemId: entry.id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity: entry.quantity,
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
        ratings: []
      });
    });

    let orders = ordersData.map(order => {
      const buyerInfo = parseAddress(order.buyer_address, true);
      const sellerInfo = parseAddress(order.seller_address, false);

      return {
        ...order,
        order_items: itemsByOrder[order.id] || [],
        total_quantity: qtyByOrder[order.id] || 0,
        buyer_info: buyerInfo.info,
        buyer_full_address: buyerInfo.fullAddress,
        seller_info: sellerInfo.info,
        seller_full_address: sellerInfo.fullAddress,
        is_rated: false
      };
    });

    orderCache.set(cacheKey, orders);

    orders = await attachRatings(orders, userInfo.id);

    return res.status(200).json({ message: "✅ Daftar order dibatalkan berhasil diambil.", orders });
  } catch (err) {
    console.error("❌ Server error (canceled):", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// ======================
// GET orders diterima oleh pembeli
// ======================
router.get("/received", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) return res.status(401).json({ message: "❌ Harus login untuk melihat daftar order diterima." });

    const cacheKey = `orders:received:${userInfo.id}`;
    let cachedOrders = orderCache.get(cacheKey);

    if (cachedOrders) {
      const updatedOrders = await attachRatings(cachedOrders, userInfo.id);
      return res.status(200).json({ message: "✅ Daftar order diterima berhasil diambil.", orders: updatedOrders });
    }

    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address")
      .eq("user_id", userInfo.id)
      .eq("status", "diterima oleh pembeli")
      .order("created_at", { ascending: false });

    if (orderError) return res.status(500).json({ message: "❌ Gagal mengambil data order diterima.", error: orderError });
    if (!ordersData.length) return res.status(200).json({ message: "✅ Tidak ada order diterima.", orders: [] });

    const orderIds = ordersData.map(o => o.id);
    const [orderItemsRes, detailItemsRes] = await Promise.all([
      supabase.from("order_items").select("id, order_id, product_id, variant_id, quantity").in("order_id", orderIds),
      supabase.from("order_details_items").select("*").in("order_id", orderIds)
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    const orderItemMap = {};
    orderItems.forEach(oi => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      orderItemMap[key] = { id: oi.id, quantity: oi.quantity ?? 0 };
    });

    const qtyByOrder = {};
    orderItems.forEach(item => {
      qtyByOrder[item.order_id] = (qtyByOrder[item.order_id] || 0) + (item.quantity ?? 0);
    });

    const itemsByOrder = {};
    detailItems.forEach(item => {
      const key = `${item.order_id}-${item.product_id}-${item.variant_id ?? "null"}`;
      const entry = orderItemMap[key] || { id: null, quantity: 0 };

      itemsByOrder[item.order_id] = itemsByOrder[item.order_id] || [];
      itemsByOrder[item.order_id].push({
        orderItemId: entry.id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity: entry.quantity,
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
        ratings: []
      });
    });

    let orders = ordersData.map(order => {
      const buyerInfo = parseAddress(order.buyer_address, true);
      const sellerInfo = parseAddress(order.seller_address, false);

      return {
        ...order,
        order_items: itemsByOrder[order.id] || [],
        total_quantity: qtyByOrder[order.id] || 0,
        buyer_info: buyerInfo.info,
        buyer_full_address: buyerInfo.fullAddress,
        seller_info: sellerInfo.info,
        seller_full_address: sellerInfo.fullAddress,
        is_rated: false
      };
    });

    orderCache.set(cacheKey, orders);

    orders = await attachRatings(orders, userInfo.id);

    return res.status(200).json({ message: "✅ Daftar order diterima berhasil diambil.", orders });
  } catch (err) {
    console.error("❌ Server error (received):", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// =====================================
// 🛒 POST /cart/checkout
// =====================================
router.post("/cart/checkout", async (req, res) => {
  const startTime = Date.now();
  console.log("===== 🛒 [CHECKOUT ROUTE DIPANGGIL] =====");
  console.log("📥 Body request:", req.body);
  console.log("🍪 Cookies:", req.cookies);

  try {
    const { itemsToCheckout, pickupMethod, address, paymentMethod, selectedPaymentChannel } = req.body;
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

    console.log("👤 User info:", userInfo);

    // 🔐 Validate user login
    if (!userInfo?.id) {
      console.error("❌ Tidak ada user ID. Harus login.");
      return res.status(401).json({ message: "❌ Harus login untuk checkout." });
    }

    // 🔹 Validate items
    if (!itemsToCheckout?.length) {
      console.error("⚠️ Tidak ada item untuk di-checkout.");
      return res.status(400).json({ message: "⚠️ Tidak ada item untuk di-checkout." });
    }

    // 🔹 Validate payment method
    if (!paymentMethod || !["cod", "digital", "balance"].includes(paymentMethod.toLowerCase())) {
      console.error("⚠️ Metode pembayaran tidak valid:", paymentMethod);
      return res.status(400).json({
        message: "⚠️ Metode pembayaran tidak valid. Pilih 'cod', 'digital', atau 'balance'.",
      });
    }

    // 🔹 Validate payment channel for digital payments
    if (paymentMethod.toLowerCase() === "digital" && !selectedPaymentChannel) {
      console.error("⚠️ Channel pembayaran diperlukan untuk metode digital.");
      return res.status(400).json({
        message: "⚠️ Channel pembayaran diperlukan untuk metode pembayaran digital.",
      });
    }

    // 🔹 Validate payment channel
    if (paymentMethod.toLowerCase() === "digital") {
      const channels = await getXenditChannels();
      const validChannel = channels.find(c => c.channel_code === selectedPaymentChannel);
      if (!validChannel) {
        console.error("⚠️ Channel pembayaran tidak valid:", selectedPaymentChannel);
        return res.status(400).json({
          message: "⚠️ Channel pembayaran tidak valid.",
        });
      }
    }

    // 🔹 Fetch buyer info
    let buyerAddress = null;
    console.log("🔍 Ambil data user dari Supabase:", userInfo.id);
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select(`
        alamat_lengkap,
        provinsi,
        kota_kabupaten,
        kecamatan,
        kelurahan,
        kode_pos,
        nama_penerima,
        no_telepon,
        email,
        username
      `)
      .eq("id", userInfo.id)
      .single();

    if (userError) {
      console.error("❌ Gagal ambil data user:", userError.message);
      return res.status(500).json({
        message: "❌ Gagal memeriksa data buyer.",
        error: userError.message,
      });
    }

    // 🔹 Check if delivery is required
    const adaDiantar = itemsToCheckout.some(
      (item) =>
        (pickupMethod
          ? pickupMethod.toLowerCase()
          : (item.pickupMethod || "diambil").toLowerCase()) === "diantar"
    );

    // 🔹 Validate and update address if delivery is required
    if (adaDiantar) {
      const isAlamatLengkap =
        userData &&
        Object.values({
          alamat_lengkap: userData.alamat_lengkap,
          provinsi: userData.provinsi,
          kota_kabupaten: userData.kota_kabupaten,
          kecamatan: userData.kecamatan,
          kelurahan: userData.kelurahan,
          kode_pos: userData.kode_pos,
          nama_penerima: userData.nama_penerima,
          no_telepon: userData.no_telepon,
        }).every(Boolean);

      if (!isAlamatLengkap && address) {
        console.log("🔄 Updating user address...");
        const {
          nama_penerima,
          no_telepon,
          alamat_lengkap,
          kode_pos,
          provinsi_id,
          kota_id,
          kecamatan_id,
          kelurahan_id,
        } = address;

        if (
          !nama_penerima ||
          !no_telepon ||
          !alamat_lengkap ||
          !kode_pos ||
          !provinsi_id ||
          !kota_id ||
          !kecamatan_id ||
          !kelurahan_id
        ) {
          console.error("⚠️ Address data incomplete:", address);
          return res.status(400).json({
            message: "⚠️ Lengkapi semua field alamat pengiriman.",
            needUpdateAddress: true,
          });
        }

        const [provinsiData, kotaData, kecamatanData, kelurahanData] = await Promise.all([
          supabase.from("provinces").select("name").eq("id", provinsi_id).single(),
          supabase.from("regencies").select("name").eq("id", kota_id).single(),
          supabase.from("districts").select("name").eq("id", kecamatan_id).single(),
          supabase.from("villages").select("name").eq("id", kelurahan_id).single(),
        ]);

        if (
          provinsiData.error ||
          kotaData.error ||
          kecamatanData.error ||
          kelurahanData.error
        ) {
          console.error("❌ Gagal mengambil data wilayah:", {
            provinsiError: provinsiData.error,
            kotaError: kotaData.error,
            kecamatanError: kecamatanData.error,
            kelurahanError: kelurahanData.error,
          });
          return res.status(500).json({
            message: "❌ Gagal memvalidasi data wilayah.",
            error: "Invalid region data",
          });
        }

        const { error: updateError } = await supabase
          .from("users")
          .update({
            nama_penerima,
            no_telepon,
            alamat_lengkap,
            kode_pos,
            provinsi: provinsiData.data.name,
            kota_kabupaten: kotaData.data.name,
            kecamatan: kecamatanData.data.name,
            kelurahan: kelurahanData.data.name,
          })
          .eq("id", userInfo.id);

        if (updateError) {
          console.error("❌ Gagal update alamat user:", updateError.message);
          return res.status(500).json({
            message: "❌ Gagal memperbarui alamat.",
            error: updateError.message,
          });
        }

        buyerAddress = {
          nama_penerima,
          no_telepon,
          alamat_lengkap,
          kode_pos,
          provinsi: provinsiData.data.name,
          kota_kabupaten: kotaData.data.name,
          kecamatan: kecamatanData.data.name,
          kelurahan: kelurahanData.data.name,
          email: userData.email,
          username: userData.username,
        };
      } else if (!isAlamatLengkap) {
        console.error("⚠️ Alamat tidak lengkap untuk pengiriman.");
        return res.status(400).json({
          message: "⚠️ Lengkapi alamat pengiriman terlebih dahulu.",
          needUpdateAddress: true,
        });
      } else {
        buyerAddress = userData;
      }
    } else {
      buyerAddress = userData;
    }

    // 🔹 Fetch products and variants
    const productIds = [...new Set(itemsToCheckout.map((i) => i.productId))];
    const cacheKeyProducts = `products:${productIds.sort().join(",")}`;
    let products = cache.get(cacheKeyProducts);

    if (!products) {
      console.log("📡 Fetch produk + varian dari Supabase...");
      const [productRowsRes, variantRowsRes] = await Promise.all([
        supabase.from("products").select("*").in("id", productIds),
        supabase.from("product_variants").select("*").in("product_id", productIds),
      ]);

      if (!productRowsRes.data?.length) {
        console.error("❌ Gagal ambil produk:", productRowsRes.error);
        return res
          .status(500)
          .json({ message: "❌ Gagal mengambil data produk.", error: productRowsRes.error });
      }
      if (variantRowsRes.error) {
        console.error("❌ Gagal ambil varian:", variantRowsRes.error);
        return res
          .status(500)
          .json({ message: "❌ Gagal mengambil varian.", error: variantRowsRes.error });
      }

      products = productRowsRes.data.map((p) => ({
        ...p,
        variants: variantRowsRes.data.filter((v) => v.product_id === p.id),
      }));

      products = await attachVariantsStockDiscountWithRealDiscount(products);
      cache.set(cacheKeyProducts, products);
    }

    // 🔹 Fetch seller data
    const sellerIds = [...new Set(products.map((p) => p.seller_id))];
    const cacheKeySellers = `sellers:${sellerIds.sort().join(",")}`;
    let sellerData = cache.get(cacheKeySellers);

    if (!sellerData) {
      console.log("📡 Fetch seller data dari Supabase...");
      const { data } = await supabase
        .from("sellers")
        .select(`
          id,
          store_name,
          email,
          delivery_fee,
          is_delivery_available,
          store_address,
          kelurahan,
          kecamatan,
          kabupaten,
          provinsi,
          kode_pos,
          latitude,
          longitude
        `)
        .in("id", sellerIds);
      sellerData = data || [];
      cache.set(cacheKeySellers, sellerData);
    }
    const sellerMap = Object.fromEntries(sellerData.map((s) => [s.id, s]));

    // 🔹 Call checkout_atomic RPC
    console.log("⚡ Memanggil RPC checkout_atomic...");
    const snakeCaseItems = itemsToCheckout.map((i) => ({
      product_id: i.productId,
      variant_id: i.variantId,
      qty: i.qty,
    }));

    const { data: createdOrders, error: rpcError } = await supabase.rpc("checkout_atomic", {
      items_json: snakeCaseItems,
      user_id: userInfo.id,
      pickup_method: pickupMethod,
      address_json: buyerAddress || address || null,
      payment_method: paymentMethod.toLowerCase(),
      payment_id: null, // Initially null
      payment_channel: null, // Initially null
      payment_expiry: null // Initially null
    });

    if (rpcError) {
      console.error("❌ Checkout atomic gagal:", rpcError);
      return res.status(400).json({ message: rpcError.message });
    }

    // 🔹 Calculate delivery stats
    const productMap = Object.fromEntries(products.map((p) => [p.id, p]));
    let pickupOnlyItemsCount = 0;
    let totalItemsCount = 0;

    itemsToCheckout.forEach((item) => {
      const product = productMap[item.productId];
      if (!product) return;

      const seller = sellerMap[product.seller_id];
      if (!seller) return;

      const method = pickupMethod
        ? pickupMethod.toLowerCase()
        : (item.pickupMethod || "diambil").toLowerCase();

      const itemQty = item.qty || 1;
      totalItemsCount += itemQty;

      if (method === "diantar" && !seller.is_delivery_available) {
        pickupOnlyItemsCount += itemQty;
      }
    });

    // 🔹 Process payments and update orders
    const finalOrders = [];
    for (const order of createdOrders || []) {
      let paymentUrl = null;
      let paymentStatus = order.payment_status || "pending";

      if (paymentMethod.toLowerCase() === "digital") {
        try {
          const invoiceData = {
            external_id: `order-${order.id}`,
            amount: Number(order.total_price),
            description: `Pembayaran order ${order.id}`,
            success_redirect_url: `${BASE_URL}/success?order_id=${order.id}`,
            failure_redirect_url: `${BASE_URL}/failure?order_id=${order.id}`,
            currency: "IDR",
            invoice_duration: 12 * 60 * 60, // 12 hours in seconds for digital payment expiration
            payment_methods: [selectedPaymentChannel], // Lock payment method
          };

          const invoiceRes = await axios.post(
            `${XENDIT_BASE_URL}/v2/invoices`,
            invoiceData,
            { auth: { username: XENDIT_SECRET_KEY, password: "" } }
          );

          paymentUrl = invoiceRes.data.invoice_url;

          // Verify invoice
          const checkInvoice = await axios.get(
            `${XENDIT_BASE_URL}/v2/invoices/${invoiceRes.data.id}`,
            { auth: { username: XENDIT_SECRET_KEY, password: "" } }
          );
          console.log("📄 Invoice Xendit Verified:", checkInvoice.data.status);

          // Update order with payment details
          const paymentExpiry = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
          const { error: updateError } = await supabase
            .from("orders")
            .update({
              payment_id: invoiceRes.data.id,
              payment_url: paymentUrl,
              payment_channel: selectedPaymentChannel,
              payment_expiry: paymentExpiry,
            })
            .eq("id", order.id);

          if (updateError) {
            console.error("❌ Gagal update payment details:", updateError.message);
            throw new Error("Gagal memperbarui detail pembayaran");
          }

          order.payment_id = invoiceRes.data.id;
          order.payment_url = paymentUrl;
          order.payment_channel = selectedPaymentChannel;
          order.payment_expiry = paymentExpiry;
        } catch (err) {
          console.error("❌ Xendit invoice error:", err?.response?.data || err.message);
          return res.status(500).json({
            message: "❌ Gagal memproses pembayaran digital.",
            error: err.message,
          });
        }
      } else if (paymentMethod.toLowerCase() === "balance") {
        try {
          const totalPrice = Number(order.total_price);
          if (totalPrice <= 0) {
            console.warn(`⚠️ Total price for order ${order.id} is 0 or negative. Skipping payment.`);
            continue;
          }

          const userBalance = await getUserBalance(userInfo.id);
          if (userBalance.balance < totalPrice) {
            console.error(`❌ Insufficient balance for user ${userInfo.id} on order ${order.id}`);
            return res.status(400).json({
              message: `⚠️ Saldo tidak cukup. Saldo saat ini: ${userBalance.balance}, dibutuhkan: ${totalPrice}.`,
            });
          }

          await withdrawUserBalance(userInfo.id, totalPrice, {
            orderId: order.id,
            metadata: { source: "order_payment_balance" },
          });

          await supabase
            .from("orders")
            .update({
              payment_status: "paid",
              status: "processing",
              payment_method: "balance",
              payment_id: `BAL-${order.id}`, // Custom payment ID for balance
              payment_channel: "balance", // Custom channel for balance
              payment_expiry: null, // No expiry for balance payment
            })
            .eq("id", order.id);

          paymentStatus = "paid";
          order.payment_status = "paid";
          order.status = "processing";
          order.payment_id = `BAL-${order.id}`;
          order.payment_channel = "balance";
          order.payment_expiry = null;

          const platformFee = 0;
          const netToSeller = totalPrice - platformFee;
          if (netToSeller > 0) {
            await mintSellerBalance(order.seller_id, netToSeller, {
              orderId: order.id,
              metadata: { source: "balance_payment_credit", grossAmount: totalPrice, platformFee },
            });
          }
        } catch (err) {
          console.error(`❌ Balance payment error for order ${order.id}:`, err.message);
          await supabase
            .from("orders")
            .update({
              payment_status: "failed",
              status: "pending",
            })
            .eq("id", order.id);
          return res.status(500).json({
            message: "❌ Gagal memproses pembayaran menggunakan saldo.",
            error: err.message,
          });
        }
      } else if (paymentMethod.toLowerCase() === "cod") {
        // For COD, set minimal payment details
        await supabase
          .from("orders")
          .update({
            payment_id: `COD-${order.id}`, // Custom payment ID for COD
            payment_channel: "cod", // Custom channel for COD
            payment_expiry: null, // No expiry for COD
          })
          .eq("id", order.id);

        order.payment_id = `COD-${order.id}`;
        order.payment_channel = "cod";
        order.payment_expiry = null;
      }

      // 🔹 Snapshot order items and send email
      (async () => {
        const orderItems = itemsToCheckout
          .filter((item) => productMap[item.productId]?.seller_id === order.seller_id)
          .map((item) => {
            const product = productMap[item.productId];
            const variant = product?.variants?.find((v) => v.id === item.variantId);
            const finalPrice = variant?.final_price ?? product?.finalPrice;
            return {
              product,
              variant,
              finalPrice,
              discountPercentage: product?.discount_percentage ?? 0,
              variantDiscountPercentage: variant?.applied_discount ?? 0,
              qty: item.qty,
              productId: item.productId,
              variantId: item.variantId,
            };
          });

        const snapshotItems = orderItems.map((i) => ({
          order_id: order.id,
          product_id: i.productId,
          product_name: i.product.product_name,
          product_price: i.product.price,
          final_price: i.finalPrice,
          discount_percentage: i.discountPercentage,
          product_image_url: safeParseImageUrl(i.product.product_image_url),
          variant_id: i.variant?.id || null,
          variant_name: i.variant?.variant_name || null,
          variant_price: i.variant?.price ?? null,
          variant_final_price: i.variant?.final_price ?? null,
          variant_discount_percentage: i.variantDiscountPercentage,
          variant_image_url: i.variant?.variant_image_url || null,
        }));

        await supabase.from("order_item_details").insert(snapshotItems);
        await supabase.from("order_details_items").insert(snapshotItems);

        const seller = sellerMap[order.seller_id];
        const sellerAddress = {
          store_name: seller?.store_name || "Toko Seller",
          store_address: seller?.store_address || "",
          kelurahan: seller?.kelurahan || "",
          kecamatan: seller?.kecamatan || "",
          kabupaten: seller?.kabupaten || "",
          provinsi: seller?.provinsi || "",
          kode_pos: seller?.kode_pos || "",
          latitude: seller?.latitude || null,
          longitude: seller?.longitude || null,
        };

        const buyerAddressFormatted = {
          nama_penerima: buyerAddress?.nama_penerima || "",
          no_telepon: buyerAddress?.no_telepon || "",
          alamat_lengkap: buyerAddress?.alamat_lengkap || "",
          kode_pos: buyerAddress?.kode_pos || "",
          provinsi: buyerAddress?.provinsi || "",
          kota_kabupaten: buyerAddress?.kota_kabupaten || "",
          kecamatan: buyerAddress?.kecamatan || "",
          kelurahan: buyerAddress?.kelurahan || "",
        };

        await axios.post(`${SEND_URL}/send-email-order`, {
          order_id: order.id,
          products: orderItems.map((i) => ({
            product_name: i.product.product_name,
            variant_name: i.variant?.variant_name || null,
            quantity: i.qty,
            total_price: i.finalPrice * i.qty,
            product_image_url:
              i.variant?.variant_image_url || safeParseImageUrl(i.product.product_image_url),
          })),
          buyer_email: userInfo.email,
          seller_email: seller?.email,
          buyer_username: userInfo.username,
          seller_username: seller?.store_name || "Toko Seller",
          pickup_method: order.pickup_method,
          new_status: paymentStatus === "paid" ? "processing" : "pending",
          seller_address: sellerAddress,
          total_price: Number(order.total_price),
          delivery_fee: Number(seller?.delivery_fee || 0),
          buyer_address: buyerAddressFormatted,
          updated_at: order.updated_at || new Date().toISOString(),
          created_at: order.created_at || new Date().toISOString(),
          payment_channel: order.payment_channel || null,
          payment_expiry: order.payment_expiry || null,
          ...(paymentMethod.toLowerCase() === "balance" && paymentStatus === "paid" && {
            balance_notification: true,
          }),
        });
      })();

      finalOrders.push({ ...order, payment_url: paymentUrl });
    }

    // 🔹 Remove items from cart
    const { data: cart } = await supabase
      .from("carts")
      .select("items")
      .eq("user_id", userInfo.id)
      .maybeSingle();

    if (cart?.items?.length) {
      const remainingItems = cart.items.filter(
        (cartItem) =>
          !itemsToCheckout.some(
            (checkoutItem) =>
              checkoutItem.productId === cartItem.productId &&
              (checkoutItem.variantId || null) === (cartItem.variantId || null)
          )
      );
      await supabase.from("carts").update({ items: remainingItems }).eq("user_id", userInfo.id);
    }

    // 🔹 Format response
    const endTime = Date.now();
    const successMessage =
      pickupOnlyItemsCount > 0
        ? `✅ Berhasil checkout ${finalOrders.length} order. ⚠️ ${pickupOnlyItemsCount} item tidak bisa diantar, tapi bisa diambil sendiri ke toko. (⏱ ${(endTime - startTime) / 1000}s)`
        : `✅ Berhasil checkout ${finalOrders.length} order. Semua item siap diproses! (⏱ ${(endTime - startTime) / 1000}s)`;

    return res.status(200).json({
      message: successMessage,
      orders: finalOrders,
      delivery_stats: {
        total_items: totalItemsCount,
        pickup_only_items: pickupOnlyItemsCount,
        delivery_available_items: totalItemsCount - pickupOnlyItemsCount,
      },
    });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// =====================================
// 🛒 POST /cart/delivery-fee
// =====================================
router.post("/cart/delivery-fee", async (req, res) => {
  try {
    const { itemsToCheckout, pickupMethod } = req.body;
    const mode = getXenditMode();

    // --- Ambil user dari cookies/session ---
    const userInfo = req.cookies?.user_info
      ? JSON.parse(req.cookies.user_info)
      : null;
    if (!userInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login dulu." });
    }

    if (!itemsToCheckout?.length) {
      return res.status(400).json({
        message: "⚠️ Tidak ada item untuk dihitung biaya kirim.",
      });
    }

    // =============================
    // 1. Ambil data produk
    // =============================
    const productIds = Array.from(
      new Set(itemsToCheckout.map((i) => i.productId))
    ).sort();
    const cacheKeyProducts = `products:${productIds.join(",")}`;

    let products = cache.get(cacheKeyProducts);
    if (!products) {
      const { data, error } = await supabase
        .from("products")
        .select("id, seller_id, product_price, product_name, product_image_url")
        .in("id", productIds);

      if (error || !data?.length) {
        return res.status(500).json({
          message: "❌ Gagal mengambil data produk.",
          error: error?.message,
        });
      }

      products = await attachVariantsStockDiscountWithRealDiscount(data);
      cache.set(cacheKeyProducts, products);
    }
    const productMap = new Map(products.map((p) => [p.id, p]));

    // =============================
    // 2. Ambil data seller
    // =============================
    const sellerIds = Array.from(new Set(products.map((p) => p.seller_id))).sort();
    const cacheKeySellers = `sellers:fee:${sellerIds.join(",")}`;

    let sellers = cache.get(cacheKeySellers);
    if (!sellers) {
      const { data, error } = await supabase
        .from("sellers")
        .select("id, store_name, delivery_fee, is_delivery_available")
        .in("id", sellerIds);

      if (error) {
        return res.status(500).json({
          message: "❌ Gagal mengambil data seller.",
          error: error.message,
        });
      }

      sellers = data || [];
      cache.set(cacheKeySellers, sellers);
    }
    const sellerMap = new Map(sellers.map((s) => [s.id, s]));

    // =============================
    // 3. Group item per seller-method
    // =============================
    const groupedOrders = itemsToCheckout.reduce((acc, item) => {
      const product = productMap.get(item.productId);
      if (!product) return acc;

      let method;
      if (pickupMethod) {
        method = pickupMethod.toLowerCase();
      } else {
        method = (item.pickupMethod || "diambil").toLowerCase();
      }
      if (method === "pengambilan") method = "diambil";

      const key = `${product.seller_id}-${method}`;
      if (!acc[key]) {
        acc[key] = {
          seller_id: product.seller_id,
          pickup_method: method,
          items: [],
        };
      }
      acc[key].items.push(item);
      return acc;
    }, {});

    // =============================
    // 4. Hitung total per group
    // =============================
    const resultPerGroup = Object.values(groupedOrders)
      .map((group) => {
        const seller = sellerMap.get(group.seller_id);
        if (!seller) return null;

        const totalProduk = group.items.reduce((sum, item) => {
          const productData = productMap.get(item.productId);
          const price =
            productData?.finalPrice ?? productData?.product_price ?? 0;
          return sum + price * (item.qty || 1);
        }, 0);

        let delivery_fee = 0;
        let delivery_note = "tidak bisa diantar";
        let delivery_status = "pickup_only";

        if (group.pickup_method === "diantar") {
          if (seller.is_delivery_available === true) {
            delivery_fee = seller.delivery_fee || 0;
            delivery_note = "bisa diantar";
            delivery_status = "delivery_available";
          } else {
            delivery_note = "tidak bisa diantar - hanya pickup";
          }
        } else if (group.pickup_method === "diambil") {
          if (seller.is_delivery_available === true) {
            delivery_note = "bisa diantar (tapi pickup dipilih)";
            delivery_status = "delivery_available";
          } else {
            delivery_note = "hanya bisa pickup";
          }
        }

        const itemCount = group.items.reduce(
          (sum, item) => sum + (item.qty || 1),
          0
        );

        return {
          seller_id: seller.id,
          store_name: seller.store_name,
          pickup_method: group.pickup_method,
          total_produk: totalProduk,
          delivery_fee,
          delivery_note,
          delivery_status,
          item_count: itemCount,
          total_semua: totalProduk + delivery_fee,
        };
      })
      .filter(Boolean);

    // =============================
    // 5. Hitung grand totals
    // =============================
    const grandTotalProduk = resultPerGroup.reduce(
      (sum, s) => sum + s.total_produk,
      0
    );
    const grandTotalOngkir = resultPerGroup.reduce(
      (sum, s) => sum + s.delivery_fee,
      0
    );
    const grandTotalSemua = grandTotalProduk + grandTotalOngkir;

    const totalItems = itemsToCheckout.reduce(
      (sum, item) => sum + (item.qty || 1),
      0
    );
    const pickupOnlyItems = resultPerGroup
      .filter((g) => g.delivery_status === "pickup_only")
      .reduce((sum, g) => sum + g.item_count, 0);
    const deliveryAvailableItems = totalItems - pickupOnlyItems;

    // =============================
    // 6. Ambil wallet & payment methods
    // =============================
      const wallet = await getUserBalance(userInfo.id);

      // ✅ Ambil daftar channel dari Xendit
      const channels = await getXenditChannels();

      // ✅ Ambil logo + limits dari util
      const { CHANNEL_LOGOS, CHANNEL_LIMITS } = await Listpaymentchanel();

      // 🚀 Mapping channels dengan filter min/max + logo
      const mappedChannels = channels.map((c) => {
        const limits = CHANNEL_LIMITS[c.channel_code] || {};
        const logo = CHANNEL_LOGOS[c.channel_code] || null;

        const isAvailable =
          grandTotalSemua >= (limits.min_amount || 0) &&
          (limits.max_amount ? grandTotalSemua <= limits.max_amount : true);

        return {
          channel_code: c.channel_code,
          name: c.name,
          type: c.channel_category,
          is_enabled: c.is_enabled,
          currency: c.currency,
          logo,
          min_amount: limits.min_amount || 0,
          max_amount: limits.max_amount || null,
          available: isAvailable,
          note: isAvailable ? "bisa bayar" : "tidak bisa bayar",
        };
      });

    // =============================
    // 7. Return response
    // =============================
    return res.status(200).json({
      message: "✅ Data checkout berhasil dihitung.",
      sellers: resultPerGroup,
      total_produk_semua: grandTotalProduk,
      total_ongkir_semua: grandTotalOngkir,
      total_checkout_semua: grandTotalSemua,
      delivery_stats: {
        total_items: totalItems,
        pickup_only_items: pickupOnlyItems,
        delivery_available_items: deliveryAvailableItems,
        message:
          pickupOnlyItems > 0
            ? `⚠️ ${pickupOnlyItems} item tidak bisa diantar, tapi bisa diambil sendiri ke toko`
            : "✅ Semua item bisa diantar",
      },
      payment_methods: {
        cod: {
          method: "cod",
          name: "Cash on Delivery",
          available: true,
        },
        balance: {
          method: "balance",
          name: "Saldo Akun",
          available: true,
          balance: wallet.balance,
          withdrawable_balance: wallet.withdrawable_balance,
        },
        xendit: {
          env: mode,
          channels: mappedChannels,
        },
      },
    });
  } catch (err) {
    console.error("❌ Server error:", err.response?.data || err.message);
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server.",
      error: err.message,
    });
  }
});


router.post("/orders/:id/confirm-receive", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) return res.status(401).json({ message: "❌ Harus login." });

    const orderId = req.params.id;

    // Ambil order
    const { data: order, error } = await supabase
      .from("orders")
      .select("id, status, user_id")
      .eq("id", orderId)
      .single();

    if (error || !order) return res.status(404).json({ message: "❌ Order tidak ditemukan." });
    if (String(order.user_id) !== String(userInfo.id))
      return res.status(403).json({ message: "⚠️ Tidak punya akses ke order ini." });
    if (order.status !== "diterima")
      return res.status(400).json({ message: "⚠️ Hanya order yang sudah diantar oleh penjual / sudah diambil" });

    // Hitung rating deadline (1 hari dari sekarang)
    const ratingDeadline = new Date();
    ratingDeadline.setDate(ratingDeadline.getDate() + 1);

    // Update status, rating_deadline, dan kosongkan confirm_by_buyers_deadline
    const { data: updated, error: updateError } = await supabase
      .from("orders")
      .update({ 
        status: "diterima oleh pembeli",
        rating_deadline: ratingDeadline.toISOString(),
        confirm_by_buyers_deadline: null
      })
      .eq("id", orderId)
      .select()
      .single();

    if (updateError) return res.status(500).json({ message: "❌ Gagal update status." });

    return res.status(200).json({ 
      message: "✅ Order berhasil dikonfirmasi diterima.", 
      order: updated 
    });
  } catch (err) {
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

router.delete("/orders/:id", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) return res.status(401).json({ message: "❌ Harus login." });

    const orderId = req.params.id;

    // Pastikan order milik user + ambil status
    const { data: order, error } = await supabase
      .from("orders")
      .select("id, user_id, status")
      .eq("id", orderId)
      .single();

    if (error || !order) return res.status(404).json({ message: "❌ Order tidak ditemukan." });
    if (String(order.user_id) !== String(userInfo.id))
      return res.status(403).json({ message: "⚠️ Tidak punya akses ke order ini." });

    // Hanya boleh hapus kalau status "diterima oleh pembeli"
    if (order.status !== "diterima oleh pembeli") {
      return res.status(400).json({ message: "⚠️ Order hanya bisa dihapus jika sudah diterima oleh pembeli." });
    }

    // Hapus order_items terkait
    const { error: itemsError } = await supabase
      .from("order_items")
      .delete()
      .eq("order_id", orderId);

    if (itemsError) return res.status(500).json({ message: "❌ Gagal hapus order_items." });

    // Hapus order
    const { error: delError } = await supabase
      .from("orders")
      .delete()
      .eq("id", orderId);

    if (delError) return res.status(500).json({ message: "❌ Gagal hapus order." });

    return res.status(200).json({ message: "✅ Order dan order_items berhasil dihapus. Rating tetap aman." });
  } catch (err) {
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});


// 🔐 Modified router to use getXenditInvoice
router.get("/:orderId/payment", async (req, res) => {
  try {
    const { orderId } = req.params;
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

    // 🔐 Check if user is logged in
    if (!userInfo?.id) {
      return res
        .status(401)
        .json({ message: "❌ Harus login untuk melihat detail pembayaran." });
    }

    // 🔹 Fetch order data from Supabase
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(
        `
        id,
        user_id,
        total_price,
        payment_method,
        payment_status,
        payment_id,  
        payment_url,
        payment_channel,
        payment_expiry,
        created_at,
        updated_at
      `
      )
      .eq("id", orderId)
      .eq("user_id", userInfo.id)
      .single();

    if (orderError || !order) {
      console.error("❌ Gagal ambil order:", orderError?.message);
      return res.status(404).json({ message: "❌ Order tidak ditemukan." });
    }

    // 🔹 Validate: Only for digital payment method and pending status
    if (order.payment_method !== "digital" || order.payment_status !== "pending") {
      return res.status(400).json({
        message:
          "⚠️ Endpoint ini hanya untuk order dengan pembayaran digital yang masih pending.",
      });
    }

    // 🔹 Fetch channel details from Xendit
    const channels = await getXenditChannels();
    const channelInfo = channels.find(
      (c) => c.channel_code === order.payment_channel
    );

    if (!channelInfo) {
      console.error("⚠️ Channel tidak ditemukan:", order.payment_channel);
      return res
        .status(404)
        .json({ message: "⚠️ Informasi channel pembayaran tidak ditemukan." });
    }

    // 🔹 Fetch invoice details if Virtual Account
    let virtualAccountNumber = null;
    if (channelInfo.channel_category === "VIRTUAL_ACCOUNT") {
      const invoice = await getXenditInvoice(order.payment_id);
      if (invoice?.payment_details?.virtual_account_number) {
        virtualAccountNumber = invoice.payment_details.virtual_account_number;
      }
    }

    // 🔹 Build payment instructions based on channel
    let instructions = [];
    if (order.payment_channel === "BNI" || order.payment_channel === "BNI_VA") {
      instructions = [
        {
          section: "Temukan ATM Terdekat",
          steps: [
            "1. Masukkan kartu ATM anda",
            "2. Pilih bahasa",
            "3. Masukkan PIN ATM anda",
          ],
        },
        {
          section: "Detail Pembayaran",
          steps: [
            '1. Pilih "Menu Lainnya"',
            '2. Pilih "Transfer"',
            '3. Pilih jenis rekening yang akan anda gunakan (contoh: "Dari Rekening Tabungan")',
            '4. Pilih "Virtual Account Billing"',
            `5. Masukkan Nomor Virtual Account anda ${virtualAccountNumber || "[NOMOR_VA]"}`,
            "6. Tagihan yang harus dibayarkan akan muncul pada layar konfirmasi",
            "7. Konfirmasi, apabila telah sesuai, lanjutkan transaksi",
          ],
        },
        {
          section: "Transaksi Berhasil",
          steps: [
            "1. Transaksi Anda telah selesai",
            "2. Setelah transaksi anda selesai, invoice ini akan diupdate secara otomatis. Proses ini mungkin memakan waktu hingga 5 menit",
          ],
        },
      ];
    } else if (channelInfo.instructions) {
      instructions = channelInfo.instructions;
    } else {
      instructions = [
        {
          section: "Default",
          steps: [
            "1. Buka link pembayaran yang disediakan.",
            "2. Pilih metode pembayaran sesuai channel yang dipilih.",
            "3. Ikuti langkah-langkah pembayaran di halaman Xendit.",
            "4. Pastikan pembayaran selesai sebelum expiry time.",
          ],
        },
      ];
    }

    // 🔹 Check Xendit mode (sandbox or live)
    const mode = await getXenditMode();
    let sandboxInfo = null;
    if (mode === "sandbox") {
      sandboxInfo = {
        simulation_url: order.payment_url,
        note: "Ini adalah mode sandbox. Kunjungi URL pembayaran di atas, lalu klik tombol 'Simulate Successful Payment' untuk mensimulasikan pembayaran sukses secara langsung. Atau gunakan endpoint /simulate/:orderId untuk trigger via API (untuk test webhook).",
        auto_success: false,
      };
    }

    // 🔹 Format response
    const response = {
      order_id: order.id,
      total_amount: Number(order.total_price),
      payment_method: order.payment_method,
      payment_status: order.payment_status,
      payment_channel: order.payment_channel,
      payment_url: order.payment_url,
      payment_expiry: order.payment_expiry,
      created_at: order.created_at,
      updated_at: order.updated_at,
      instructions,
      virtual_account_number: virtualAccountNumber,
      channel_details: {
        channel_name: channelInfo.channel_name,
        channel_category: channelInfo.channel_category,
        currency: channelInfo.currency,
        min_limit: channelInfo.min_limit,
        max_limit: channelInfo.max_limit,
      },
    };

    if (sandboxInfo) {
      response.sandbox_info = sandboxInfo;
    }

    return res.status(200).json({
      message: "✅ Detail dan instruksi pembayaran berhasil diambil.",
      payment_details: response,
    });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res
      .status(500)
      .json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

router.post("/simulate/:orderId", async (req, res) => {
  try {
    if (getXenditMode() !== "sandbox") {
      return res.status(403).json({ message: "⚠️ Hanya tersedia di mode sandbox." });
    }

    const { orderId } = req.params;
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

    if (!userInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login." });
    }

    // Fetch order
    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .eq("user_id", userInfo.id)
      .single();

    if (error || !order || order.payment_status !== "pending") {
      return res.status(400).json({ message: "❌ Order tidak valid atau sudah dibayar." });
    }

    // Simulate menggunakan SDK (asumsi VA dari invoice)
    const { CallbackVirtualAccount } = x;
    await CallbackVirtualAccount.simulatePayment({
      externalID: order.id,  // Asumsi external_id = order.id
      amount: Number(order.total_price),
    });

    return res.status(200).json({ message: "✅ Pembayaran disimulasikan. Webhook akan trigger sebentar lagi." });
  } catch (err) {
    console.error("❌ Simulate error:", err);
    return res.status(500).json({ message: "❌ Gagal simulate", error: err.message });
  }
});
// Route GET /all - daftar order user
// ======================
// GET all orders + items + ratings
// ======================
router.get("/all", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) return res.status(401).json({ message: "❌ Harus login untuk melihat daftar order." });

    const cacheKey = `orders:list:${userInfo.id}`;
    let cachedOrders = orderCache.get(cacheKey);

    // 🔹 Ambil data dari cache dulu
    if (cachedOrders) {
      // tetep cek ratings terbaru untuk update is_rated
      const updatedOrders = await attachRatings(cachedOrders, userInfo.id);
      return res.status(200).json({ message: "✅ Daftar order berhasil diambil.", orders: updatedOrders });
    }

    // 🔹 Ambil semua order milik user
    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address")
      .eq("user_id", userInfo.id)
       .not("status", "in", "(dibatalkan)")
      .order("created_at", { ascending: false });

    if (orderError) return res.status(500).json({ message: "❌ Gagal mengambil data order.", error: orderError });
    if (!ordersData.length) return res.status(200).json({ message: "✅ Tidak ada order.", orders: [] });

    // 🔹 Ambil detail items
    const orderIds = ordersData.map(o => o.id);
    const [orderItemsRes, detailItemsRes] = await Promise.all([
      supabase.from("order_items").select("id, order_id, product_id, variant_id, quantity").in("order_id", orderIds),
      supabase.from("order_details_items").select("*").in("order_id", orderIds)
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    // 🔹 Mapping order items
    const orderItemMap = {};
    orderItems.forEach(oi => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      orderItemMap[key] = { id: oi.id, quantity: oi.quantity ?? 0 };
    });

    const qtyByOrder = {};
    orderItems.forEach(item => {
      qtyByOrder[item.order_id] = (qtyByOrder[item.order_id] || 0) + (item.quantity ?? 0);
    });

    const itemsByOrder = {};
    detailItems.forEach(item => {
      const key = `${item.order_id}-${item.product_id}-${item.variant_id ?? "null"}`;
      const entry = orderItemMap[key] || { id: null, quantity: 0 };

      itemsByOrder[item.order_id] = itemsByOrder[item.order_id] || [];
      itemsByOrder[item.order_id].push({
        orderItemId: entry.id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity: entry.quantity,
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
        ratings: [] // nanti attachRatings update
      });
    });

    // 🔹 Format orders
    let orders = ordersData.map(order => {
      const orderItemsWithRatings = itemsByOrder[order.id] || [];

      const buyerInfo = parseAddress(order.buyer_address, true);
      const sellerInfo = parseAddress(order.seller_address, false);

      return {
        ...order,
        order_items: orderItemsWithRatings,
        total_quantity: qtyByOrder[order.id] || 0,
        buyer_info: buyerInfo.info,
        buyer_full_address: buyerInfo.fullAddress,
        seller_info: sellerInfo.info,
        seller_full_address: sellerInfo.fullAddress,
        is_rated: false
      };
    });

    // 🔹 Cache orders
    orderCache.set(cacheKey, orders);

    // 🔹 Attach ratings terbaru
    orders = await attachRatings(orders, userInfo.id);

    return res.status(200).json({ message: "✅ Daftar order berhasil diambil.", orders });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});
// ======================
// GET order by ID
// ======================
router.get("/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) return res.status(401).json({ message: "❌ Harus login untuk melihat detail order." });

    const cacheKey = `order:detail:${userInfo.id}:${orderId}`;
    let cached = orderCache.get(cacheKey);

    if (cached) {
      cached = await attachRatings([cached], userInfo.id);
      return res.status(200).json({ message: "✅ Detail order berhasil diambil (cache).", order: cached[0] });
    }

    // 🔹 Ambil order utama
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address")
      .eq("id", orderId)
      .eq("user_id", userInfo.id)
      .single();

    if (orderError || !order) return res.status(404).json({ message: "❌ Order tidak ditemukan.", error: orderError });

    // 🔹 Ambil order_items + detail items
    const [orderItemsRes, detailItemsRes] = await Promise.all([
      supabase.from("order_items").select("id, order_id, product_id, variant_id, quantity").eq("order_id", orderId),
      supabase.from("order_details_items").select("*").eq("order_id", orderId)
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    const orderItemMap = {};
    orderItems.forEach(oi => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      orderItemMap[key] = { id: oi.id, quantity: oi.quantity ?? 0 };
    });

    const totalQuantity = orderItems.reduce((sum, i) => sum + (i.quantity ?? 0), 0);

    const items = detailItems.map(item => {
      const key = `${item.order_id}-${item.product_id}-${item.variant_id ?? "null"}`;
      const entry = orderItemMap[key] || { id: null, quantity: 0 };
      return {
        orderItemId: entry.id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity: entry.quantity,
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
        ratings: []
      };
    });

    const buyerInfo = parseAddress(order.buyer_address, true);
    const sellerInfo = parseAddress(order.seller_address, false);

    let orderResult = {
      ...order,
      order_items: items,
      total_quantity: totalQuantity,
      buyer_info: buyerInfo.info,
      buyer_full_address: buyerInfo.fullAddress,
      seller_info: sellerInfo.info,
      seller_full_address: sellerInfo.fullAddress,
      is_rated: false
    };

    // 🔹 Cache order
    orderCache.set(cacheKey, orderResult);

    // 🔹 Attach ratings
    const finalOrder = (await attachRatings([orderResult], userInfo.id))[0];

    return res.status(200).json({ message: "✅ Detail order berhasil diambil.", order: finalOrder });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// ======================
// Helper functions
// ======================

// Attach ratings + update is_rated
async function attachRatings(orders, userId) {
  if (!orders.length) return orders;

  const orderIds = orders.map(o => o.id);

  const { data: ratingsData } = await supabase.from("ratings").select(`
    id, order_id, order_item_id, product_id, variant_id, rating, review_text, review_images,
    created_at,
    product_snapshot,
    rating_replies ( id, reply_text, created_at, seller_id, sellers (id, store_name, store_image_url) )
  `).eq("user_id", userId).in("order_id", orderIds);

  const ratingsMap = {};
  (ratingsData || []).forEach(r => {
    if (!ratingsMap[r.order_item_id]) ratingsMap[r.order_item_id] = [];
    ratingsMap[r.order_item_id].push(r);
  });

  return orders.map(order => {
    const updatedItems = (order.order_items || []).map(item => ({
      ...item,
      ratings: ratingsMap[item.orderItemId] || []
    }));
    const isRated = updatedItems.some(i => i.ratings.length > 0);
    return { ...order, order_items: updatedItems, is_rated: isRated };
  });
}

// Parse address JSON
function parseAddress(address, isBuyer = true) {
  if (!address) return { info: null, fullAddress: null };
  try {
    const addr = typeof address === "string" ? JSON.parse(address) : address;
    if (isBuyer) {
      const { alamat_lengkap = "", kelurahan = "", kecamatan = "", kota_kabupaten = "", provinsi = "", kode_pos = "" } = addr;
      return { info: addr, fullAddress: [alamat_lengkap, kelurahan, kecamatan, kota_kabupaten, provinsi, kode_pos].filter(Boolean).join(", ") };
    } else {
      const { store_address = "", kelurahan = "", kecamatan = "", kota_kabupaten = "", provinsi = "" } = addr;
      return { info: addr, fullAddress: [store_address, kelurahan, kecamatan, kota_kabupaten, provinsi].filter(Boolean).join(", ") };
    }
  } catch {
    return { info: null, fullAddress: null };
  }
}




module.exports = router;
