// routes/checkout.js
const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const axios = require("axios");
const detectspam = require("../middleware/detectSpam");
const verifyCaptcha = require("../middleware/verifyCaptcha");
const {
  attachVariantsStockDiscountWithRealDiscount,
} = require("../utils/applyDiscountAndVariants");
const {Xendit} = require("xendit-node");
const { DateTime } = require("luxon");
const crypto = require("crypto");
const NodeCache = require("node-cache");

// -----------------------------
// Environment variables
// -----------------------------
const SEND_URL = process.env.SEND_SERVICE_URL;
const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL;
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

// -----------------------------
// Xendit init
// -----------------------------
const xendit = new Xendit({ secretKey: XENDIT_SECRET_KEY });
const { Invoice } = xendit;

// -----------------------------
// Cache setup
// -----------------------------
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
const orderCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });

const cacheGet = (k) => cache.get(k);
const cacheSet = (k, v, ttlSec = 60) => cache.set(k, v, ttlSec);

// -----------------------------
// Helper crypto utilities
// -----------------------------
/**
 * Generate deterministic "wallet address" for a seller using HMAC-SHA256(sellerId)
 * Not a blockchain address — hanya identifier yang derived secara kriptografis.
 */
function generateWalletAddress(sellerId) {
  return crypto
    .createHmac("sha256", CRYPTO_SECRET_KEY)
    .update(String(sellerId))
    .digest("hex");
}

/**
 * Sign arbitrary payload (object) using HMAC-SHA256 and return hex signature.
 * We canonicalize payload by JSON.stringify with stable key ordering.
 */
function signPayload(payload) {
  const stableStringify = (obj) => {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj))
      return `[${obj.map(stableStringify).join(",")}]`;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",")}}`;
  };
  const str = stableStringify(payload);
  return crypto
    .createHmac("sha256", CRYPTO_SECRET_KEY)
    .update(str)
    .digest("hex");
}

function verifySignature(payload, signature) {
  const expected = signPayload(payload);
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex")
  );
}

// -----------------------------
// Helper DB wallet operations
// -----------------------------
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

/**
 * Mint (credit) seller balance.
 */
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

/**
 * Withdraw (debit) seller balance.
 */
async function withdrawSellerBalance(sellerId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getSellerBalance(sellerId);
  if (Number(current) < Number(amount)) {
    throw new Error("Insufficient funds");
  }
  const newBalance = Number(current) - Number(amount);
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

// -----------------------------
// Small helpers
// -----------------------------
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


// ✅ Checkout Route
router.post("/cart/checkout", async (req, res) => {
  const startTime = Date.now();
  console.log("===== 🛒 [CHECKOUT ROUTE DIPANGGIL] =====");
  console.log("📥 Body request:", req.body);
  console.log("🍪 Cookies:", req.cookies);

  try {
    const { itemsToCheckout, pickupMethod, address, paymentMethod } = req.body;
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

    console.log("👤 User info:", userInfo);

    if (!itemsToCheckout?.length) {
      console.log("⚠️ Tidak ada item untuk di-checkout.");
      return res.status(400).json({ message: "⚠️ Tidak ada item untuk di-checkout." });
    }
    if (!paymentMethod || !["cod", "digital"].includes(paymentMethod.toLowerCase())) {
      return res.status(400).json({
        message: "⚠️ Metode pembayaran tidak valid. Pilih 'cod' atau 'digital'.",
      });
    }

    // ==========================
    // 🔹 Ambil buyer info
    // ==========================
    let buyerAddress = null;
    if (userInfo?.id) {
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

      console.log("📦 Data user:", userData);
      if (userError) {
        console.error("❌ Gagal ambil data user:", userError.message);
        return res.status(500).json({
          message: "❌ Gagal memeriksa data buyer.",
          error: userError.message,
        });
      }

      // Cek apakah ada item yang memerlukan delivery
      const adaDiantar = itemsToCheckout.some(
        (item) =>
          (pickupMethod
            ? pickupMethod.toLowerCase()
            : (item.pickupMethod || "diambil").toLowerCase()) === "diantar"
      );
      console.log("🚚 Ada item diantar?", adaDiantar);

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

        console.log("🏠 Alamat lengkap?", isAlamatLengkap);

        if (!isAlamatLengkap && address) {
          // Update user address if provided in the request
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

          // Validate required address fields
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
            console.log("⚠️ Address data incomplete:", address);
            return res.status(400).json({
              message: "⚠️ Lengkapi semua field alamat pengiriman.",
              needUpdateAddress: true,
            });
          }

          // Fetch region names based on IDs
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

          // Update user address in the users table
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

          console.log("✅ Alamat user berhasil diupdate.");
          // Set buyerAddress with updated data
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
    }

    // ==========================
    // 🔹 Ambil produk + varian
    // ==========================
    const productIds = [...new Set(itemsToCheckout.map((i) => i.productId))];
    console.log("🛍 Product IDs:", productIds);

    const cacheKeyProducts = `products:${productIds.sort().join(",")}`;
    let products = cache.get(cacheKeyProducts);

    if (!products) {
      console.log("📡 Fetch produk + varian dari Supabase...");
      const [productRowsRes, variantRowsRes] = await Promise.all([
        supabase.from("products").select("*").in("id", productIds),
        supabase.from("product_variants").select("*").in("product_id", productIds),
      ]);

      console.log("📦 Produk:", productRowsRes.data);
      console.log("📦 Variants:", variantRowsRes.data);

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
    } else {
      console.log("✅ Produk dari cache");
    }

    const sellerIds = [...new Set(products.map((p) => p.seller_id))];
    console.log("🏪 Seller IDs:", sellerIds);

    const cacheKeySellers = `sellers:${sellerIds.sort().join(",")}`;
    let sellerData = cache.get(cacheKeySellers);

    if (!sellerData) {
      console.log("📡 Fetch seller data dari Supabase...");
      const { data } = await supabase
        .from("sellers")
        .select("id, store_name, email, delivery_fee, is_delivery_available")
        .in("id", sellerIds);
      sellerData = data || [];
      cache.set(cacheKeySellers, sellerData);
    } else {
      console.log("✅ Seller data dari cache");
    }
    const sellerMap = Object.fromEntries(sellerData.map((s) => [s.id, s]));
    console.log("🗺 Seller Map:", sellerMap);

    // ==========================
    // 🔹 Panggil RPC checkout_atomic
    // ==========================
    console.log("⚡ Memanggil RPC checkout_atomic...");
    const snakeCaseItems = itemsToCheckout.map(i => ({
      product_id: i.productId,
      variant_id: i.variantId,
      qty: i.qty
    }));

    const { data: createdOrders, error: rpcError } = await supabase.rpc("checkout_atomic", {
      items_json: snakeCaseItems,
      user_id: userInfo?.id || null,
      pickup_method: pickupMethod,
      address_json: buyerAddress || address || null,
      payment_method: paymentMethod.toLowerCase(),
    });

    if (rpcError) {
      console.error("❌ Checkout atomic gagal:", rpcError);
      return res.status(400).json({ message: rpcError.message });
    }

    console.log("✅ Orders dibuat (dari RPC):", createdOrders);

    // ==========================
    // 🔹 Hitung delivery stats
    // ==========================
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

    console.log("📊 Delivery Stats:", { totalItemsCount, pickupOnlyItemsCount });

    // ==========================
    // 🔹 Buat Xendit Invoice (jika digital) dan kirim notifikasi
    // ==========================
    const finalOrders = [];
    for (const order of createdOrders || []) {
      let paymentUrl = null;
      if (paymentMethod.toLowerCase() === "digital") {
        try {
          const invoiceRes = await axios.post(
            "https://api.xendit.co/v2/invoices",
            {
              external_id: `order-${order.id}`,
              amount: Number(order.total_price),
              description: `Pembayaran order ${order.id}`,
              success_redirect_url: `${FRONTEND_URL}/payment/success?order_id=${order.id}`,
              failure_redirect_url: `${FRONTEND_URL}/payment/failure?order_id=${order.id}`,
              currency: "IDR",
            },
            { auth: { username: XENDIT_SECRET_KEY, password: "" } }
          );

          paymentUrl = invoiceRes.data.invoice_url;

          // ✅ GET Invoice buat verifikasi
          const checkInvoice = await axios.get(
            `https://api.xendit.co/v2/invoices/${invoiceRes.data.id}`,
            { auth: { username: XENDIT_SECRET_KEY, password: "" } }
          );
          console.log("📄 Invoice Xendit Verified:", checkInvoice.data.status);

          await supabase
            .from("orders")
            .update({
              payment_id: invoiceRes.data.id,
              payment_url: paymentUrl,
            })
            .eq("id", order.id);

          order.payment_id = invoiceRes.data.id;
          order.payment_url = paymentUrl;
        } catch (err) {
          console.error("❌ Xendit invoice error:", err?.response?.data || err.message);
          // Continue processing other orders even if invoice creation fails
        }
      }

      // Snapshot & email background
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
        console.log("📸 Snapshot Items:", snapshotItems);

        await supabase.from("order_item_details").insert(snapshotItems);
        await supabase.from("order_details_items").insert(snapshotItems);

        if (userInfo) {
          console.log("📧 Kirim notifikasi email ke buyer & seller");
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
            seller_email: sellerMap[order.seller_id]?.email,
            buyer_username: userInfo.username,
            pickup_method: order.pickup_method,
            new_status: "pending",
            pickup_only_note:
              order.pickup_method === "diantar" && !sellerMap[order.seller_id]?.is_delivery_available
                ? "Item ini hanya bisa diambil sendiri ke toko"
                : null,
          });
        }
      })();

      finalOrders.push({ ...order, payment_url: paymentUrl });
    }

    // ==========================
    // 🔹 Hapus item dari cart
    // ==========================
    if (userInfo?.id) {
      console.log("🗑 Hapus item dari cart...");
      const { data: cart } = await supabase
        .from("carts")
        .select("items")
        .eq("user_id", userInfo.id)
        .maybeSingle();
      console.log("🛒 Cart sebelum hapus:", cart);

      if (cart?.items?.length) {
        const remainingItems = cart.items.filter(
          (cartItem) =>
            !itemsToCheckout.some(
              (checkoutItem) =>
                checkoutItem.productId === cartItem.productId &&
                (checkoutItem.variantId || null) === (cartItem.variantId || null)
            )
        );
        console.log("🛒 Cart setelah hapus:", remainingItems);
        await supabase.from("carts").update({ items: remainingItems }).eq("user_id", userInfo.id);
      }
    }

    // ==========================
    // 🔹 Response
    // ==========================
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

// -----------------------------
// Webhook Xendit
// -----------------------------
router.post("/payment/webhook", async (req, res) => {
  try {
    const { external_id, status } = req.body;
    if (!external_id) return res.status(400).send("missing external_id");

    const orderId = external_id.split("-")[1];
    if (!orderId) return res.status(400).send("invalid external_id");

    if (status === "PAID") {
      await supabase
        .from("orders")
        .update({ payment_status: "paid", status: "processing" })
        .eq("id", orderId);
      console.log(`✅ Pembayaran order ${orderId} sukses.`);

      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .single();
      if (orderErr || !order) {
        console.error("❌ Gagal ambil order untuk distribusi:", orderErr);
        return res.status(500).send("error");
      }

      const sellerId = order.seller_id;
      const grossAmount = Number(order.total_price || 0);
      const platformFee = 0;
      const netToSeller = grossAmount - platformFee;

      try {
        const newBalance = await mintSellerBalance(sellerId, netToSeller, {
          orderId,
          metadata: { source: "xendit_paid", grossAmount, platformFee },
        });

        console.log(
          `➡️ Credited seller ${sellerId} amount ${netToSeller}. New balance: ${newBalance}`
        );
      } catch (e) {
        console.error("❌ Gagal credit seller balance:", e);
      }
    } else if (status === "EXPIRED") {
      await supabase
        .from("orders")
        .update({ payment_status: "expired", status: "dibatalkan" })
        .eq("id", orderId);
      console.log(`⚠ Pembayaran order ${orderId} expired.`);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err?.message || err);
    res.status(500).send("Error");
  }
});




router.post("/cart/delivery-fee", async (req, res) => {
  try {
    const { itemsToCheckout, pickupMethod } = req.body;

    if (!itemsToCheckout?.length) {
      return res.status(400).json({
        message: "⚠️ Tidak ada item untuk dihitung biaya kirim.",
      });
    }

    // Ambil productId unik dan sort sekali aja buat cache key
    const productIds = Array.from(
      new Set(itemsToCheckout.map((i) => i.productId)),
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

    // Map produk buat akses O(1)
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Ambil seller unik dan sort sekali buat cache
    const sellerIds = Array.from(
      new Set(products.map((p) => p.seller_id)),
    ).sort();
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

    // Map seller buat akses O(1)
    const sellerMap = new Map(sellers.map((s) => [s.id, s]));

    // Group items per seller-method
    const groupedOrders = itemsToCheckout.reduce((acc, item) => {
      const product = productMap.get(item.productId);
      if (!product) return acc;

      let method;

      if (pickupMethod) {
        // Kalau ada pickupMethod global → override semua
        method = pickupMethod.toLowerCase();
      } else {
        // Kalau tidak ada → ikut item.pickupMethod atau default "diambil"
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

    // Hitung per grup
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

        // Logika delivery_fee berdasarkan is_delivery_available
        let delivery_fee = 0;
        let delivery_note = "tidak bisa diantar"; // Default
        let delivery_status = "pickup_only"; // Default

        if (group.pickup_method === "diantar") {
          if (seller.is_delivery_available === true) {
            delivery_fee = seller.delivery_fee || 0;
            delivery_note = "bisa diantar";
            delivery_status = "delivery_available";
          } else {
            delivery_fee = 0;
            delivery_note = "tidak bisa diantar - hanya pickup";
            delivery_status = "pickup_only";
          }
        } else if (group.pickup_method === "diambil") {
          delivery_fee = 0;
          if (seller.is_delivery_available === true) {
            delivery_note = "bisa diantar (tapi pickup dipilih)";
            delivery_status = "delivery_available";
          } else {
            delivery_note = "hanya bisa pickup";
            delivery_status = "pickup_only";
          }
        }

        // Hitung jumlah items
        const itemCount = group.items.reduce((sum, item) => sum + (item.qty || 1), 0);

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

    // Hitung grand totals
    const grandTotalProduk = resultPerGroup.reduce(
      (sum, s) => sum + s.total_produk,
      0,
    );
    const grandTotalOngkir = resultPerGroup.reduce(
      (sum, s) => sum + s.delivery_fee,
      0,
    );
    const grandTotalSemua = grandTotalProduk + grandTotalOngkir;

    // Hitung statistik delivery
    const totalItems = itemsToCheckout.reduce((sum, item) => sum + (item.qty || 1), 0);
    const pickupOnlyItems = resultPerGroup
      .filter(g => g.delivery_status === "pickup_only")
      .reduce((sum, g) => sum + g.item_count, 0);
    const deliveryAvailableItems = totalItems - pickupOnlyItems;

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
        message: pickupOnlyItems > 0 
          ? `⚠️ ${pickupOnlyItems} item tidak bisa diantar, tapi bisa diambil sendiri ke toko`
          : "✅ Semua item bisa diantar",
      },
    });
  } catch (err) {
    console.error("❌ Server error:", err);
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
