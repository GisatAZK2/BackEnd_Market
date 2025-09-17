// routes/checkout.js
const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const axios = require("axios");
const { Xendit } = require("xendit-node");
const { DateTime } = require("luxon");
const crypto = require("crypto");
const NodeCache = require("node-cache");

// Environment variables
const SEND_URL = process.env.SEND_SERVICE_URL;
const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL;
const CRYPTO_SECRET_KEY =
  process.env.CRYPTO_SECRET_KEY || "please_set_a_real_secret_in_env";

if (!XENDIT_SECRET_KEY) {
  console.warn("⚠️ XENDIT_SECRET_KEY belum diset - invoice creation akan gagal jika dipanggil.");
}
if (!CRYPTO_SECRET_KEY) {
  console.warn("⚠️ CRYPTO_SECRET_KEY belum diset - signatures tidak aman.");
}

// Xendit init
const xendit = new Xendit({ secretKey: XENDIT_SECRET_KEY });
const { Invoice } = xendit;

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

async function withdrawUserBalance(userId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getUserBalance(userId);
  if (Number(current) < Number(amount)) {
    throw new Error("Insufficient funds");
  }
  const newBalance = Number(current) - Number(amount);
  await upsertUserBalance(userId, newBalance);
  await recordUserTransaction({
    userId,
    amount,
    type: "debit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
}

// Webhook for payment status
router.post("/payment/webhook", async (req, res) => {
  try {
    const { external_id, status } = req.body;
    if (!external_id) {
      console.warn("⚠ Missing external_id in webhook payload");
      return res.status(400).send("missing external_id");
    }

    const orderId = external_id.replace(/^order-/, "");
    if (!orderId || orderId.length < 36) {
      console.warn("⚠ Invalid external_id format:", external_id);
      return res.status(400).send("invalid external_id");
    }

    console.log(`🔔 Webhook received for orderId: ${orderId}, status: ${status}`);

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*, buyer:users(id, email, username), seller:sellers(id, email)")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) {
      console.error("❌ Gagal ambil order:", orderErr || "Order not found");
      return res.status(500).send("error fetching order");
    }

    console.log("DEBUG: Order data:", order);

    const sellerId = order.seller_id;
    const grossAmount = Number(order.total_price ?? 0);
    const platformFee = 0;
    const netToSeller = grossAmount - platformFee;

    if (!sellerId) {
      console.error(`❌ Order ${orderId} tidak punya sellerId. Tidak bisa credit seller.`);
      return res.status(500).send("invalid sellerId");
    }

    if (status === "PAID") {
      const { error: updateErr } = await supabase
        .from("orders")
        .update({ payment_status: "paid" })
        .eq("id", orderId);

      if (updateErr) {
        console.error("❌ Gagal update order status:", updateErr);
        return res.status(500).send("error updating order status");
      }
      console.log(`✅ Order ${orderId} payment_status set to 'paid'.`);

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

      // Send email notification
      try {
        await axios.post(`${SEND_URL}/send-email-order`, {
          order_id: orderId,
          buyer_email: order.buyer?.email,
          seller_email: order.seller?.email,
          buyer_username: order.buyer?.username,
          new_status: "paid",
        });
        console.log(`✅ Sent payment confirmation email for order ${orderId}`);
      } catch (emailErr) {
        console.error(`❌ Failed to send payment email for order ${orderId}:`, emailErr.message);
      }
    } else if (status === "EXPIRED") {
      const { error: expireErr } = await supabase
        .from("orders")
        .update({ payment_status: "expired", status: "dibatalkan", refund_requested: true })
        .eq("id", orderId);

      if (expireErr) {
        console.error("❌ Gagal update order status expired:", expireErr);
        return res.status(500).send("error updating order status");
      }
      console.log(`⚠ Order ${orderId} payment expired.`);

      // Handle refund if already paid
      if (order.payment_status === "paid") {
        const netAmount = grossAmount - platformFee;
        if (netAmount <= 0) {
          console.warn(`⚠ Net amount for refund is 0 or negative for order ${orderId}. Skipping refund.`);
        } else {
          try {
            await withdrawSellerBalance(sellerId, netAmount, {
              orderId,
              metadata: { source: "expired_payment_refund_debit" },
            });
            await mintUserBalance(order.buyer.id, netAmount, {
              orderId,
              metadata: { source: "expired_payment_refund_credit" },
            });
            await supabase
              .from("orders")
              .update({
                refund_status: "completed",
                refunded_at: new Date().toISOString(),
                refund_requested: false,
              })
              .eq("id", orderId);
            console.log(`✅ Refund processed for expired order ${orderId}`);
          } catch (refundErr) {
            console.error(`❌ Refund failed for order ${orderId}:`, refundErr.message);
            await supabase
              .from("orders")
              .update({
                refund_status: "failed",
                refund_requested: true,
              })
              .eq("id", orderId);
          }
        }
      }

      // Send email notification
      try {
        await axios.post(`${SEND_URL}/send-email-order`, {
          order_id: orderId,
          buyer_email: order.buyer?.email,
          seller_email: order.seller?.email,
          buyer_username: order.buyer?.username,
          new_status: "dibatalkan",
          cancel_reason: "❌ Payment expired",
        });
        console.log(`✅ Sent expiration email for order ${orderId}`);
      } catch (emailErr) {
        console.error(`❌ Failed to send expiration email for order ${orderId}:`, emailErr.message);
      }
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