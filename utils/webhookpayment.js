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

router.post("/payment/webhook", async (req, res) => {
  try {
    const { external_id, status } = req.body;
    if (!external_id) {
      console.warn("⚠ Missing external_id in webhook payload");
      return res.status(400).send("missing external_id");
    }

    const orderId = external_id.split("-")[1];
    if (!orderId) {
      console.warn("⚠ Invalid external_id format:", external_id);
      return res.status(400).send("invalid external_id");
    }

    console.log(`🔔 Webhook received for orderId: ${orderId}, status: ${status}`);

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) {
      console.error("❌ Gagal ambil order:", orderErr);
      return res.status(500).send("error fetching order");
    }

    console.log("DEBUG: Order data:", order);

    const sellerId = order.seller_id;
    const grossAmount = Number(order.total_price ?? 0);
    const platformFee = 0;
    const netToSeller = grossAmount - platformFee;

    console.log("DEBUG: sellerId:", sellerId);
    console.log("DEBUG: grossAmount:", grossAmount, "netToSeller:", netToSeller);

    if (!sellerId) {
      console.error(`❌ Order ${orderId} tidak punya sellerId. Tidak bisa credit seller.`);
      return res.status(500).send("invalid sellerId");
    }

    if (status === "PAID") {
      // Update status order
      const { error: updateErr } = await supabase
        .from("orders")
        .update({ payment_status: "paid", status: "processing" })
        .eq("id", orderId);

      if (updateErr) console.error("❌ Gagal update order status:", updateErr);
      else console.log(`✅ Order ${orderId} payment_status set to 'paid'.`);

      // Credit seller balance
      if (netToSeller <= 0) {
        console.warn(`⚠ Net amount for seller is 0 or negative, skip credit. Order ${orderId}`);
      } else {
        try {
          const newBalance = await mintSellerBalance(sellerId, netToSeller, {
            orderId,
            metadata: { source: "xendit_paid", grossAmount, platformFee },
          });
          console.log(`➡️ Credited seller ${sellerId} amount ${netToSeller}. New balance: ${newBalance}`);
        } catch (e) {
          console.error("❌ Gagal credit seller balance:", e);
        }
      }
    } else if (status === "EXPIRED") {
      const { error: expireErr } = await supabase
        .from("orders")
        .update({ payment_status: "expired", status: "dibatalkan" })
        .eq("id", orderId);

      if (expireErr) console.error("❌ Gagal update order status expired:", expireErr);
      else console.log(`⚠ Order ${orderId} payment expired.`);
    } else {
      console.log(`ℹ Status webhook '${status}' tidak diproses khusus.`);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err?.message || err);
    res.status(500).send("Error");
  }
});

module.exports = router;
