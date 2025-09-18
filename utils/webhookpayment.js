const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const axios = require("axios");
const { Xendit } = require("xendit-node");
const { DateTime } = require("luxon");
const crypto = require("crypto");
const NodeCache = require("node-cache");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const {
  attachVariantsStockDiscountWithRealDiscount
} = require("../utils/applyDiscountAndVariants");

// Environment variables
const SEND_URL = process.env.SEND_SERVICE_URL;
const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;
const WITHDRAW_SECRET = process.env.WITHDRAW_SECRET || "please_set_a_real_withdraw_secret_in_env";
const FRONTEND_URL = process.env.FRONTEND_URL;
const CRYPTO_SECRET_KEY = process.env.CRYPTO_SECRET_KEY || "please_set_a_real_secret_in_env";

if (!XENDIT_SECRET_KEY) {
  console.warn("⚠️ XENDIT_SECRET_KEY belum diset - invoice creation akan gagal jika dipanggil.");
}
if (!CRYPTO_SECRET_KEY) {
  console.warn("⚠️ CRYPTO_SECRET_KEY belum diset - signatures tidak aman.");
}
if (!WITHDRAW_SECRET) {
  console.warn("⚠️ WITHDRAW_SECRET belum diset - withdrawal signatures tidak aman.");
}

// Xendit init
const xendit = new Xendit({ secretKey: XENDIT_SECRET_KEY });
const { Invoice } = xendit;

// Cache setup
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
const orderCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });

const cacheGet = (k) => cache.get(k);
const cacheSet = (k, v, ttlSec = 60) => cache.set(k, v, ttlSec);

// ===== Utility: stable stringify =====
function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",")}}`;
}

function signPayload(payload) {
  const str = stableStringify(payload);
  return crypto.createHmac("sha256", CRYPTO_SECRET_KEY).update(str).digest("hex");
}

function generateSignature(payload, secretKey) {
  const jsonPayload = stableStringify(payload);
  return crypto.createHmac("sha256", secretKey).update(jsonPayload).digest("hex");
}

// ===== Map Xendit withdraw status -> DB status =====
function mapXenditToDBStatus(xStatus) {
  if (!xStatus) return "pending";
  const s = xStatus.toString().toLowerCase();
  const mapping = {
    pending: "pending",
    processing: "processing",
    in_progress: "processing",
    completed: "success",
    success: "success",
    failed: "failed",
    reject: "rejected",
    rejected: "rejected",
    expired: "expired",
    cancel: "cancelled",
    cancelled: "cancelled",
    canceled: "cancelled",
  };
  return mapping[s] || s;
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
    .select("balance, withdrawable_balance, user_pin_hash, bank_code, account_holder_name, account_number")
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
    withdrawable_balance: Number(data?.withdrawable_balance ?? 0),
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
  const newWithdrawableBalance = Number(current.withdrawable_balance) + Number(amount);
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
// ==================================
// 🔔 Webhook untuk payment order
// ==================================
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

    const sellerId = order.seller_id;
    const grossAmount = Number(order.total_price ?? 0);
    const platformFee = 0;
    const netToSeller = grossAmount - platformFee;

    if (status === "PAID") {
      await supabase.from("orders").update({ payment_status: "paid" }).eq("id", orderId);
      console.log(`✅ Order ${orderId} payment_status set to 'paid'.`);

      if (netToSeller > 0 && sellerId) {
        await mintSellerBalance(sellerId, netToSeller, {
          orderId,
          metadata: { source: "xendit_paid", grossAmount, platformFee },
        });
      }

      try {
        await axios.post(`${SEND_URL}/send-email-order`, {
          order_id: orderId,
          buyer_email: order.buyer?.email,
          seller_email: order.seller?.email,
          buyer_username: order.buyer?.username,
          new_status: "paid",
        });
      } catch (emailErr) {
        console.error("❌ Failed to send payment email:", emailErr.message);
      }
    } else if (status === "EXPIRED") {
      await supabase
        .from("orders")
        .update({ payment_status: "expired", status: "dibatalkan", refund_requested: true })
        .eq("id", orderId);
      console.log(`⚠ Order ${orderId} payment expired.`);

      // Refund jika sudah paid
      if (order.payment_status === "paid" && netToSeller > 0 && sellerId) {
        try {
          await withdrawSellerBalance(sellerId, netToSeller, {
            orderId,
            metadata: { source: "expired_payment_refund_debit" },
          });
          await mintUserBalance(order.buyer.id, netToSeller, {
            orderId,
            metadata: { source: "expired_payment_refund_credit" },
          });
          await supabase.from("orders").update({
            refund_status: "completed",
            refunded_at: new Date().toISOString(),
            refund_requested: false,
          });
        } catch (refundErr) {
          console.error(`❌ Refund failed:`, refundErr.message);
          await supabase.from("orders").update({ refund_status: "failed", refund_requested: true }).eq("id", orderId);
        }
      }

      try {
        await axios.post(`${SEND_URL}/send-email-order`, {
          order_id: orderId,
          buyer_email: order.buyer?.email,
          seller_email: order.seller?.email,
          buyer_username: order.buyer?.username,
          new_status: "dibatalkan",
          cancel_reason: "❌ Payment expired",
        });
      } catch (emailErr) {
        console.error(`❌ Failed to send expiration email:`, emailErr.message);
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

// ==================================
// 🔔 Webhook untuk withdraw (disbursement)
// ==================================
router.post("/withdraw/webhook", async (req, res) => {
  try {
    const payload = req.body;
    console.log("🔔 Withdraw webhook diterima:", payload);

    const { id, external_id, status } = payload;
    if (!external_id) {
      return res.status(400).send("Missing external_id");
    }

    // Check both seller_withdrawals and user_withdrawals
    let withdrawData, withdrawErr, table;
    const { data: sellerWithdrawData, error: sellerWithdrawErr } = await supabase
      .from("seller_withdrawals")
      .select("*")
      .eq("external_id", external_id)
      .single();

    if (sellerWithdrawData) {
      withdrawData = sellerWithdrawData;
      withdrawErr = sellerWithdrawErr;
      table = "seller_withdrawals";
    } else {
      const { data: userWithdrawData, error: userWithdrawErr } = await supabase
        .from("user_withdrawals")
        .select("*")
        .eq("external_id", external_id)
        .single();
      withdrawData = userWithdrawData;
      withdrawErr = userWithdrawErr;
      table = "user_withdrawals";
    }

    if (withdrawErr || !withdrawData) {
      console.error("❌ Tidak menemukan withdraw record:", withdrawErr);
      return res.status(404).send("Withdraw record not found");
    }

    const dbStatus = mapXenditToDBStatus(status);
    console.log(`➡️ Update withdraw ${external_id} -> ${dbStatus}`);

    await supabase
      .from(table)
      .update({
        status: dbStatus,
        metadata: payload,
        xendit_disbursement_id: id,
      })
      .eq("id", withdrawData.id);

    if (dbStatus === "success") {
      const transactionTable = table === "seller_withdrawals" ? "seller_balance_transactions" : "user_balance_transactions";
      const idField = table === "seller_withdrawals" ? "seller_id" : "user_id";
      await supabase.from(transactionTable).insert([
        {
          [idField]: withdrawData[idField],
          amount: -withdrawData.amount,
          type: "withdrawal",
          order_id: withdrawData.id,
          timestamp: new Date().toISOString(),
          signature: generateSignature(payload, WITHDRAW_SECRET),
          metadata: payload,
        },
      ]);
      console.log("✅ Transaksi withdraw sukses tercatat");
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Withdraw webhook error:", err.message);
    return res.status(500).send("Error");
  }
});

module.exports = router;