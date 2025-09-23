const express = require("express");
const router = express.Router();
const supabase = require("../../config/supabase");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const bcrypt = require("bcryptjs");

// ===== Utility =====
function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
    .join(",")}}`;
}

function generateSignature(payload, secretKey) {
  const jsonPayload = stableStringify(payload);
  return crypto
    .createHmac("sha256", secretKey)
    .update(jsonPayload)
    .digest("hex");
}

async function getSellerBalance(sellerId) {
  const { data, error } = await supabase
    .from("seller_balances")
    .select(
      "withdrawable_balance, seller_pin_hash, bank_code, account_holder_name, account_number"
    )
    .eq("seller_id", sellerId)
    .single();

  if (error && error.code === "PGRST116") {
    return {
      withdrawable_balance: 0,
      seller_pin_hash: null,
      bank_code: null,
      account_holder_name: null,
      account_number: null,
    };
  }
  if (error) throw error;

  return {
    withdrawable_balance: Number(data?.withdrawable_balance ?? 0),
    seller_pin_hash: data?.seller_pin_hash,
    bank_code: data?.bank_code,
    account_holder_name: data?.account_holder_name,
    account_number: data?.account_number,
  };
}

// Map Xendit statuses -> DB statuses (lowercase, acceptable)
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
  return mapping[s] || s; // fallback ke string lowercase
}

// =====================================
// 📤 POST /withdraw/batch
// =====================================
router.post("/withdraw/batch", async (req, res) => {
  console.log("===== [WITHDRAW BATCH ROUTE DIPANGGIL] =====");
  console.log("📥 Request body:", req.body);

  try {
    const {
      seller_id,
      amount,
      bank_code,
      account_number,
      channel_properties,
      timestamp,
      signature,
    } = req.body;

    if (!seller_id || !amount || !bank_code || !account_number || !signature) {
      return res.status(400).json({
        error: "Missing required fields for disbursement withdraw",
      });
    }

    const { data: sellerData, error: sellerError } = await supabase
      .from("sellers")
      .select("id, store_name")
      .eq("id", seller_id)
      .single();

    if (sellerError || !sellerData) {
      return res.status(404).json({ error: "Seller not found" });
    }

    const balanceData = await getSellerBalance(seller_id);
    if (amount > balanceData.withdrawable_balance) {
      return res.status(400).json({
        error: "Saldo withdrawable tidak mencukupi",
        withdrawable_balance: balanceData.withdrawable_balance,
      });
    }

    const accountHolderName =
      channel_properties?.account_holder_name ||
      balanceData.account_holder_name ||
      "Unknown";

    const ts = timestamp || Date.now();

    // Validasi signature
    const payloadForSignature = {
      sellerId: sellerData.id,
      amount,
      bankCode: bank_code,
      accountNumber: account_number,
      accountHolderName,
      timestamp: ts,
    };

    const expectedSignature = generateSignature(
      payloadForSignature,
      process.env.WITHDRAW_SECRET
    );
    if (signature !== expectedSignature) {
      console.log("❌ Signature tidak valid.");
      return res.status(401).json({ error: "Invalid signature" });
    }

    // Payload ke Xendit
    const disbursePayload = {
      external_id: `disb-${sellerData.id}-${ts}`,
      amount: Math.round(amount),
      bank_code,
      account_holder_name: accountHolderName,
      account_number,
      description: `Withdraw saldo seller ${sellerData.store_name}`,
    };

    console.log("📤 Kirim disbursementPayload ke Xendit:", disbursePayload);

    const response = await fetch("https://api.xendit.co/disbursements", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(process.env.XENDIT_SECRET_KEY + ":").toString("base64"),
      },
      body: JSON.stringify(disbursePayload),
    });

    const disburseResp = await response.json();
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
        const newBalance = balanceData.withdrawable_balance - amount;
        const { error: updateError } = await supabase
          .from("seller_balances")
          .update({ withdrawable_balance: newBalance })
          .eq("seller_id", seller_id);

        if (updateError) console.error("❌ Gagal update saldo seller:", updateError);

        // Record transaction
        const transactionPayload = {
          seller_id,
          amount: -amount,
          type: "withdrawal",
          timestamp: new Date().toISOString(),
          metadata: disburseResp ?? {},
          signature: signature,
        };

        const { error: transactionError } = await supabase
          .from("seller_balance_transactions")
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
        seller_id,
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
        .from("seller_withdrawals")
        .insert([insertPayload]);

      if (insertError) {
        console.error("❌ Gagal simpan riwayat withdraw:", insertError);
        if (insertError?.code === "23514") {
          console.error(
            "➡️ Constraint violation pada kolom status. Cek definisi constraint `seller_withdrawals_status_check`."
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
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const { limit = 20, offset = 0, status } = req.query;

    let withdrawalsQuery = supabase
      .from("seller_withdrawals")
      .select("*")
      .eq("seller_id", sellerInfo.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) withdrawalsQuery = withdrawalsQuery.eq("status", status);

    const { data: withdrawals, error: withdrawalsError } = await withdrawalsQuery;
    if (withdrawalsError) throw withdrawalsError;

    const { data: transactions, error: transactionsError } = await supabase
      .from("seller_balance_transactions")
      .select("*")
      .eq("seller_id", sellerInfo.id);

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
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const { limit = 20, offset = 0, type } = req.query;

    let query = supabase
      .from("seller_balance_transactions")
      .select("*")
      .eq("seller_id", sellerInfo.id)
      .order("created_at", { ascending: false })
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

    return res.status(200).json({
      balance: {
        total: balance.balance,
        withdrawable: balance.withdrawable_balance,
        pending: balance.balance - balance.withdrawable_balance,
      },
    });

  } catch (err) {
    console.error("❌ Get balance error:", err.message);
    return res.status(500).json({ message: "❌ Gagal mengambil data balance." });
  }
});



module.exports = router;
