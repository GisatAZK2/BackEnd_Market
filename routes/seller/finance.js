// routes/seller/withdraw.js
const express = require("express");
const supabase = require("../../config/supabase");
const router = express.Router();
const { Xendit } = require("xendit-node");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { DateTime } = require("luxon");

const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;
const CRYPTO_SECRET_KEY = process.env.CRYPTO_SECRET_KEY || "please_set_a_real_secret_in_env";
const WITHDRAW_SECRET = process.env.WITHDRAW_SECRET || "super-secret-key";

// Inisialisasi Xendit
// Inisialisasi Xendit
const xendit = new Xendit({ secretKey: XENDIT_SECRET_KEY });
const disbursement = xendit.disbursement; // ✅ jangan pakai `new Disbursement()`

// -----------------------------
// Helper functions (sama dengan sistem wallet)
// -----------------------------
async function getSellerBalance(sellerId) {
  const { data, error } = await supabase
    .from("seller_balances")
    .select("withdrawable_balance, seller_pin_hash")
    .eq("seller_id", sellerId)
    .single();

  if (error && error.code === "PGRST116") {
    return { withdrawable_balance: 0, seller_pin_hash: null };
  }
  if (error) throw error;
  return { 
    withdrawable_balance: Number(data?.withdrawable_balance ?? 0),
    seller_pin_hash: data?.seller_pin_hash
  };
}

async function withdrawSellerBalance(sellerId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  
  const current = await getSellerBalance(sellerId);
  if (Number(current.withdrawable_balance) < Number(amount)) {
    throw new Error("Saldo withdrawable tidak mencukupi");
  }
  
  const newWithdrawableBalance = Number(current.withdrawable_balance) - Number(amount);
  
  // Update database
  const { data, error } = await supabase
    .from("seller_balances")
    .update({ withdrawable_balance: newWithdrawableBalance })
    .eq("seller_id", sellerId)
    .select()
    .single();
    
  if (error) throw error;
  
  // Record transaction
  await supabase.from("seller_balance_transactions").insert([{
    seller_id: sellerId,
    amount: -amount, // Negative untuk debit
    type: "withdrawal",
    order_id: opts.orderId || null,
    timestamp: DateTime.now().toISO(),
    signature: opts.signature || null,
    metadata: opts.metadata || {},
  }]);
  
  return data;
}

async function recordSellerTransaction({ sellerId, amount, type, orderId = null, metadata = {} }) {
  const timestamp = DateTime.now().toISO();
  const payloadToSign = { sellerId, amount, type, orderId, metadata, timestamp };
  
  // Sign payload (sama seperti di checkout)
  const stableStringify = (obj) => {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",")}}`;
  };
  
  const str = stableStringify(payloadToSign);
  const signature = crypto.createHmac("sha256", CRYPTO_SECRET_KEY).update(str).digest("hex");

  const insertObj = {
    seller_id: sellerId,
    amount,
    type,
    order_id: orderId,
    timestamp,
    signature,
    metadata,
  };

  const { error } = await supabase.from("seller_balance_transactions").insert([insertObj]);
  if (error) throw error;
}

// Utility: generate HMAC signature untuk withdraw request
function generateWithdrawSignature(payload) {
  return crypto
    .createHmac("sha256", WITHDRAW_SECRET)
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest("hex");
}

// === Withdraw dengan PIN + HMAC + Xendit Integration ===
router.post("/withdraw", async (req, res) => {
  const startTime = Date.now();
  console.log("===== 💸 [WITHDRAW REQUEST] =====");
  console.log("📥 Request body:", req.body);

  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;
      
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const { amount, bankCode, accountHolderName, accountNumber, signature, pin } = req.body;
    
    // Validasi input
    if (!amount || amount <= 0 || amount > 50000000) { // Max 50 juta per withdraw
      return res.status(400).json({ message: "⚠️ Amount harus antara Rp1 - Rp50.000.000." });
    }
    
    if (!bankCode || !accountHolderName || !accountNumber) {
      return res.status(400).json({ message: "⚠️ Bank code, nama pemilik rekening, dan nomor rekening wajib diisi." });
    }
    
    if (!pin || pin.toString().length < 4) {
      return res.status(400).json({ message: "⚠️ PIN minimal 4 digit." });
    }

    if (!signature) {
      return res.status(400).json({ message: "⚠️ Signature wajib untuk keamanan." });
    }

    console.log(`🔍 Validating seller ${sellerInfo.id} for withdraw ${amount}`);

    // 1. Ambil saldo withdrawable & PIN hash
    const balanceData = await getSellerBalance(sellerInfo.id);
    console.log(`💳 Current withdrawable: ${balanceData.withdrawable_balance}`);
    
    if (balanceData.withdrawable_balance < amount) {
      return res.status(400).json({ 
        message: `⚠️ Saldo withdrawable (${balanceData.withdrawable_balance.toLocaleString()}) tidak mencukupi untuk withdraw ${amount.toLocaleString()}.` 
      });
    }

    // 2. Validasi PIN dengan bcrypt
    if (!balanceData.seller_pin_hash) {
      return res.status(403).json({ message: "❌ PIN belum diset. Silakan set PIN terlebih dahulu." });
    }
    
    const isPinValid = await bcrypt.compare(pin.toString(), balanceData.seller_pin_hash);
    if (!isPinValid) {
      console.warn(`🚫 Invalid PIN attempt for seller ${sellerInfo.id}`);
      // Rate limit bisa ditambahkan di sini
      return res.status(403).json({ message: "❌ PIN salah. Silakan coba lagi." });
    }

    // 3. Validasi client-side signature
    const payloadForSignature = {
      sellerId: sellerInfo.id,
      amount,
      bankCode,
      accountNumber,
      accountHolderName,
      timestamp: req.body.timestamp || Date.now(),
    };

    const expectedSignature = generateWithdrawSignature(payloadForSignature);
    if (signature !== expectedSignature) {
      console.warn(`🚫 Invalid signature for seller ${sellerInfo.id}`);
      return res.status(403).json({ message: "❌ Signature tidak valid. Refresh dan coba lagi." });
    }

    // 4. Generate unique external ID
    const externalId = `withdraw-${sellerInfo.id}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

    // 5. Buat disbursement via Xendit
    console.log(`🏦 Creating Xendit disbursement for ${amount}`);
    const disburse = await disbursement.create({
      externalID: externalId,
      amount: Math.round(amount),
      bankCode,
      accountHolderName,
      accountNumber,
      description: `Withdraw saldo seller ${sellerInfo.store_name || sellerInfo.username}`,
      isOverseas: false,
      metadata: {
        seller_id: sellerInfo.id,
        source: "seller_balance_withdraw",
      },
    });

    if (disburse.status !== "PENDING") {
      console.error(`❌ Xendit disbursement failed: ${disburse.status}`);
      return res.status(400).json({ 
        message: `⚠️ Gagal memproses withdraw: ${disburse.status}. Silakan coba lagi.` 
      });
    }

    // 6. Update balance (move dari withdrawable ke processed)
    try {
      await withdrawSellerBalance(sellerInfo.id, amount, {
        orderId: null,
        metadata: { 
          xendit_disbursement_id: disburse.id,
          bank_code: bankCode,
          account_holder: accountHolderName,
          status: disburse.status 
        },
        signature: expectedSignature,
      });
      
      console.log(`✅ Balance deducted: ${amount} from withdrawable for seller ${sellerInfo.id}`);
    } catch (balanceErr) {
      console.error("❌ Balance update failed:", balanceErr.message);
      // Jika gagal update balance, harus cancel disbursement
      try {
        await disbursement.cancel({ disbursementId: disburse.id });
      } catch (cancelErr) {
        console.error("❌ Failed to cancel disbursement after balance error:", cancelErr);
      }
      return res.status(500).json({ message: "❌ Gagal memproses withdraw. Silakan coba lagi." });
    }

    // 7. Record withdrawal request untuk tracking
    await supabase.from("seller_withdrawals").insert([{
      seller_id: sellerInfo.id,
      amount,
      status: disburse.status,
      xendit_disbursement_id: disburse.id,
      bank_code: bankCode,
      account_holder_name: accountHolderName,
      account_number: accountNumber,
      external_id: externalId,
      created_at: DateTime.now().toISO(),
      metadata: {
        signature,
        timestamp: payloadForSignature.timestamp,
      },
    }]);

    const endTime = Date.now();
    const processingTime = ((endTime - startTime) / 1000).toFixed(2);

    console.log(`✅ Withdraw processed: ${amount} ID: ${disburse.id} (${processingTime}s)`);

    return res.status(200).json({
      message: `✅ Withdraw sebesar Rp${amount.toLocaleString()} berhasil diproses.`,
      disbursement_id: disburse.id,
      external_id: externalId,
      status: disburse.status,
      estimated_settlement: disburse.estimated_settlement_date,
      processing_time: `${processingTime}s`,
      remaining_balance: balanceData.withdrawable_balance - amount,
    });

  } catch (err) {
    console.error("❌ Withdraw error:", err);
    const endTime = Date.now();
    console.error(`⏱ Processing time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
    
    return res.status(500).json({ 
      message: "❌ Terjadi kesalahan saat memproses withdraw.",
      ...(process.env.NODE_ENV === 'development' && { error: err.message })
    });
  }
});

// === Get Withdrawal History ===
router.get("/withdrawals", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;
      
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const { limit = 20, offset = 0, status } = req.query;
    
    let query = supabase
      .from("seller_withdrawals")
      .select(`
        *,
        transactions: seller_balance_transactions!inner (
          id, amount, type, timestamp, metadata, signature
        )
      `)
      .eq("seller_id", sellerInfo.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) {
      query = query.eq("status", status);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Format response
    const formattedWithdrawals = (data || []).map(withdrawal => ({
      id: withdrawal.id,
      amount: withdrawal.amount,
      status: withdrawal.status,
      created_at: withdrawal.created_at,
      bank_info: {
        code: withdrawal.bank_code,
        holder_name: withdrawal.account_holder_name,
        ...(withdrawal.account_number && { number: `****${withdrawal.account_number.slice(-4)}` }),
      },
      xendit_id: withdrawal.xendit_disbursement_id,
      transaction: withdrawal.transactions?.[0] || null,
    }));

    return res.status(200).json({
      withdrawals: formattedWithdrawals,
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        has_more: formattedWithdrawals.length === Number(limit),
        total: data?.length || 0,
      },
    });

  } catch (err) {
    console.error("❌ Get withdrawals error:", err.message);
    return res.status(500).json({ message: "❌ Gagal mengambil riwayat withdraw." });
  }
});

// === Set/Reset PIN ===
router.post("/set-pin", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;
      
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const { pin, current_pin } = req.body;
    
    if (!pin || pin.toString().length < 4 || pin.toString().length > 6) {
      return res.status(400).json({ message: "⚠️ PIN harus 4-6 digit." });
    }

    const balanceData = await getSellerBalance(sellerInfo.id);
    
    // Jika sudah ada PIN, validasi current PIN
    if (balanceData.seller_pin_hash) {
      if (!current_pin) {
        return res.status(400).json({ message: "⚠️ Current PIN diperlukan untuk mengubah PIN." });
      }
      
      const isCurrentPinValid = await bcrypt.compare(current_pin.toString(), balanceData.seller_pin_hash);
      if (!isCurrentPinValid) {
        return res.status(403).json({ message: "❌ Current PIN salah." });
      }
    }

    // Hash new PIN
    const hashedPin = await bcrypt.hash(pin.toString(), 12);
    
    // Update PIN
    const { error } = await supabase
      .from("seller_balances")
      .update({ seller_pin_hash: hashedPin })
      .eq("seller_id", sellerInfo.id);

    if (error) throw error;

    return res.status(200).json({
      message: `✅ ${balanceData.seller_pin_hash ? 'PIN berhasil diubah' : 'PIN berhasil diset'}.`,
    });

  } catch (err) {
    console.error("❌ Set PIN error:", err.message);
    return res.status(500).json({ message: "❌ Gagal mengatur PIN." });
  }
});

module.exports = router;