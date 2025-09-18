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
    .select("balance, user_pin_hash, bank_code, account_holder_name, account_number")
    .eq("user_id", userId)
    .single();

  if (error && error.code === "PGRST116") {
    return {
      balance: 0,
      user_pin_hash: null,
      bank_code: null,
      account_holder_name: null,
      account_number: null,
    };
  }
  if (error) throw error;
  return {
    balance: Number(data?.balance ?? 0),
    user_pin_hash: data?.user_pin_hash,
    bank_code: data?.bank_code,
    account_holder_name: data?.account_holder_name,
    account_number: data?.account_number,
  };
}

async function upsertUserBalance(userId, newBalance) {
  const { data, error } = await supabase
    .from("user_balances")
    .upsert(
      {
        user_id: userId,
        balance: newBalance,
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
  if (Number(current.balance) < Number(amount)) {
    throw new Error("Insufficient funds");
  }
  const newBalance = Number(current.balance) - Number(amount);
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

// =====================================
// 🔑 POST /set-pin
// =====================================
router.post("/set-pin", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

    if (!userInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai user." });
    }

    const { pin, current_pin } = req.body;

    if (!pin || pin.toString().length < 4 || pin.toString().length > 6) {
      return res.status(400).json({ message: "⚠️ PIN harus 4-6 digit." });
    }

    const balanceData = await getUserBalance(userInfo.id);

    if (balanceData.user_pin_hash) {
      if (!current_pin) {
        return res.status(400).json({
          message: "⚠️ Current PIN diperlukan untuk mengubah PIN.",
        });
      }

      const isCurrentPinValid = await bcrypt.compare(
        current_pin.toString(),
        balanceData.user_pin_hash
      );
      if (!isCurrentPinValid) {
        return res.status(403).json({ message: "❌ Current PIN salah." });
      }
    }

    const hashedPin = await bcrypt.hash(pin.toString(), 12);

    const { error } = await supabase
      .from("user_balances")
      .update({ user_pin_hash: hashedPin })
      .eq("user_id", userInfo.id);

    if (error) throw error;

    return res.status(200).json({
      message: `✅ ${
        balanceData.user_pin_hash
          ? "PIN berhasil diubah"
          : "PIN berhasil diset"
      }.`,
    });
  } catch (err) {
    console.error("❌ Set PIN error:", err);
    return res.status(500).json({ message: "❌ Gagal mengatur PIN." });
  }
});

// =====================================
// 📤 POST /withdraw/batch
// =====================================
router.post("/withdraw/batch", async (req, res) => {
  console.log("===== [USER WITHDRAW BATCH ROUTE DIPANGGIL] =====");
  console.log("📥 Request body:", req.body);

  try {
    const {
      user_id,
      amount,
      bank_code,
      account_number,
      pin,
      channel_properties,
      timestamp,
      signature,
    } = req.body;

    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id || userInfo.id !== user_id) {
      return res.status(401).json({ message: "❌ Unauthorized user." });
    }

    if (!user_id || !amount || !bank_code || !account_number || !pin || !signature) {
      return res.status(400).json({
        error: "Missing required fields for disbursement withdraw",
      });
    }

    // Validate PIN
    const balanceData = await getUserBalance(user_id);
    if (!balanceData.user_pin_hash) {
      return res.status(400).json({ message: "❌ PIN belum diset." });
    }

    const isPinValid = await bcrypt.compare(pin.toString(), balanceData.user_pin_hash);
    if (!isPinValid) {
      return res.status(403).json({ message: "❌ PIN salah." });
    }

    if (amount > balanceData.balance) {
      return res.status(400).json({
        error: "Saldo tidak mencukupi",
        balance: balanceData.balance,
      });
    }

    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("id, username")
      .eq("id", user_id)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: "User not found" });
    }

    const accountHolderName =
      channel_properties?.account_holder_name ||
      balanceData.account_holder_name ||
      userData.username;

    const ts = timestamp || Date.now();

    // Validasi signature
    const payloadForSignature = {
      userId: userData.id,
      amount,
      bankCode: bank_code,
      accountNumber: account_number,
      accountHolderName,
      timestamp: ts,
    };

    const expectedSignature = generateSignature(payloadForSignature, WITHDRAW_SECRET);
    if (signature !== expectedSignature) {
      console.log("❌ Signature tidak valid.");
      return res.status(401).json({ error: "Invalid signature" });
    }

    // Payload ke Xendit
    const disbursePayload = {
      external_id: `disb-user-${userData.id}-${ts}`,
      amount: Math.round(amount),
      bank_code,
      account_holder_name: accountHolderName,
      account_number,
      description: `Withdraw saldo user ${userData.username}`,
    };

    console.log("📤 Kirim disbursementPayload ke Xendit:", disbursePayload);

    const response = await axios.post("https://api.xendit.co/disbursements", {
      ...disbursePayload
    }, {
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " + Buffer.from(XENDIT_SECRET_KEY + ":").toString("base64"),
      },
    });

    const disburseResp = response.data;
    console.log("✅ Xendit disbursement response:", disburseResp);

    const dbStatus = mapXenditToDBStatus(disburseResp?.status || "pending");
    console.log(
      "🔁 Mapped Xendit status -> DB status:",
      disburseResp?.status,
      "->",
      dbStatus
    );

    const shouldDeduct = ["pending", "processing", "success"].includes(dbStatus);

    if (disburseResp && (disburseResp.id || disburseResp.external_id)) {
      if (shouldDeduct) {
        const newBalance = balanceData.balance - amount;
        const { error: updateError } = await supabase
          .from("user_balances")
          .update({ balance: newBalance })
          .eq("user_id", user_id);

        if (updateError) console.error("❌ Gagal update saldo user:", updateError);

        // Record transaction
        const transactionPayload = {
          user_id,
          amount: -amount,
          type: "withdrawal",
          timestamp: new Date().toISOString(),
          metadata: disburseResp ?? {},
          signature: signature,
        };

        const { error: transactionError } = await supabase
          .from("user_balance_transactions")
          .insert([transactionPayload]);

        if (transactionError) {
          console.error("❌ Gagal simpan transaksi withdraw:", transactionError);
        } else {
          console.log("📝 Transaksi withdraw berhasil dicatat:", transactionPayload);
        }
      }

      const idempotencyKey = crypto.randomUUID
        ? crypto.randomUUID()
        : uuidv4();

      const insertPayload = {
        user_id,
        amount,
        status: dbStatus,
        external_id: disbursePayload.external_id,
        xendit_disbursement_id: disburseResp.id || disbursePayload.external_id,
        bank_code,
        account_holder_name: accountHolderName,
        account_number,
        created_at: new Date().toISOString(),
        metadata: disburseResp ?? {},
        idempotency_key: idempotencyKey,
      };

      const { error: insertError } = await supabase
        .from("user_withdrawals")
        .insert([insertPayload]);

      if (insertError) {
        console.error("❌ Gagal simpan riwayat withdraw:", insertError);
        if (insertError?.code === "23514") {
          console.error(
            "➡️ Constraint violation pada kolom status. Cek definisi constraint `user_withdrawals_status_check`."
          );
        }
      } else {
        console.log("📝 Riwayat withdraw berhasil dicatat:", insertPayload);
      }
    }

    return res.json({
      message: "Withdraw disbursement dikirim ke Xendit (status sudah dimap ke DB).",
      db_status: dbStatus,
      disbursementPayload: disbursePayload,
      xenditResponse: disburseResp,
    });
  } catch (err) {
    console.error("❌ Error di withdraw disbursement:", err);
    return res.status(500).json({
      message: "Gagal memproses withdraw disbursement",
      error: err.message,
    });
  }
});

// =====================================
// 📜 GET /withdrawals
// =====================================
router.get("/withdrawals", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

    if (!userInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai user." });
    }

    const { limit = 20, offset = 0, status } = req.query;

    let withdrawalsQuery = supabase
      .from("user_withdrawals")
      .select("*")
      .eq("user_id", userInfo.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) withdrawalsQuery = withdrawalsQuery.eq("status", status);

    const { data: withdrawals, error: withdrawalsError } = await withdrawalsQuery;
    if (withdrawalsError) throw withdrawalsError;

    const { data: transactions, error: transactionsError } = await supabase
      .from("user_balance_transactions")
      .select("*")
      .eq("user_id", userInfo.id);

    if (transactionsError) throw transactionsError;

    const formattedWithdrawals = (withdrawals || []).map((withdrawal) => {
      const relatedTransaction =
        transactions.find(
          (t) => t.order_id === withdrawal.id && t.type === "withdrawal"
        ) || null;
      return {
        id: withdrawal.id,
        amount: withdrawal.amount,
        status: withdrawal.status,
        created_at: withdrawal.created_at,
        bank_info: {
          code: withdrawal.bank_code,
          holder_name: withdrawal.account_holder_name,
          ...(withdrawal.account_number && {
            number: `****${withdrawal.account_number.slice(-4)}`,
          }),
        },
        xendit_id: withdrawal.xendit_disbursement_id,
        transaction: relatedTransaction,
      };
    });

    return res.status(200).json({
      withdrawals: formattedWithdrawals,
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        has_more: formattedWithdrawals.length === Number(limit),
        total: withdrawals?.length || 0,
      },
    });
  } catch (err) {
    console.error("❌ Get withdrawals error:", err);
    return res
      .status(500)
      .json({ message: "❌ Gagal mengambil riwayat withdraw." });
  }
});

// =====================================
// 📜 GET /transactions
// =====================================
router.get("/transactions", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

    if (!userInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai user." });
    }

    const { limit = 20, offset = 0, type } = req.query;

    let query = supabase
      .from("user_balance_transactions")
      .select("*")
      .eq("user_id", userInfo.id)
      .order("timestamp", { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (type) query = query.eq("type", type);

    const { data, error } = await query;
    if (error) throw error;

    const formattedTransactions = (data || []).map((transaction) => ({
      id: transaction.id,
      amount: transaction.amount,
      type: transaction.type,
      timestamp: transaction.timestamp,
      metadata: transaction.metadata,
      signature: transaction.signature,
    }));

    return res.status(200).json({
      transactions: formattedTransactions,
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        has_more: formattedTransactions.length === Number(limit),
        total: data?.length || 0,
      },
    });
  } catch (err) {
    console.error("❌ Get transactions error:", err);
    return res
      .status(500)
      .json({ message: "❌ Gagal mengambil riwayat transaksi." });
  }
});

// =====================================
// 📜 GET /balance
// =====================================
router.get("/balance", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai user." });
    }

    const balance = await getUserBalance(userInfo.id);

    return res.status(200).json({
      balance: {
        total: balance.balance,
        withdrawable: balance.balance, // kalau memang cuma 1 balance
        pending: 0, // tidak ada balance pending
      },
    });
  } catch (err) {
    console.error("❌ Get balance error:", err.message);
    return res.status(500).json({ message: "❌ Gagal mengambil data balance." });
  }
});

module.exports = router;