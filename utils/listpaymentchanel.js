const axios = require("axios");

const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;
const XENDIT_BASE_URL = "https://api.xendit.co";

// ========================
// 🔄 Helper: Retry with exponential backoff
// ========================
async function withRetry(fn, retries = 5, delay = 500) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      // Kalau error 429 (rate limit) → tunggu dulu
      if (status === 429) {
        const waitTime = delay * Math.pow(2, attempt); // 0.5s, 1s, 2s, 4s, ...
        console.warn(`⚠️ Rate limit hit. Retry in ${waitTime}ms...`);
        await new Promise((r) => setTimeout(r, waitTime));
        attempt++;
      } else {
        throw err; // Kalau error lain, langsung throw
      }
    }
  }
  throw new Error("❌ Max retries exceeded (Xendit API).");
}

// ========================
// 🔐 Determine Xendit mode
// ========================
async function getXenditMode() {
  if (!XENDIT_SECRET_KEY) return "unknown";
  if (XENDIT_SECRET_KEY.startsWith("xnd_development")) return "sandbox";
  if (XENDIT_SECRET_KEY.startsWith("xnd_production")) return "production";
  return "unknown";
}

// ========================
// ✅ Get payment channels
// ========================
async function getXenditChannels() {
  try {
    const mode = await getXenditMode();
    console.log(`🌐 Xendit mode: ${mode}`);

    const res = await withRetry(() =>
      axios.get(`${XENDIT_BASE_URL}/payment_channels`, {
        auth: { username: XENDIT_SECRET_KEY, password: "" },
      })
    );

    if (!Array.isArray(res.data)) {
      console.error("❌ Response Xendit tidak sesuai:", res.data);
      return [];
    }

    let channels = res.data;
    if (mode === "sandbox") {
      channels = channels.filter((ch) => ch.channel_category !== "RETAIL_OUTLET");
    }

    return channels;
  } catch (err) {
    console.error("❌ Gagal ambil payment channels:", err.response?.data || err.message);
    return [];
  }
}

// ========================
// ✅ Get invoice by ID
// ========================
async function getXenditInvoice(invoiceId) {
  try {
    const mode = await getXenditMode();
    console.log(`🌐 Fetching invoice in ${mode} mode for invoice ID: ${invoiceId}`);

    const res = await withRetry(() =>
      axios.get(`${XENDIT_BASE_URL}/v2/invoices/${invoiceId}`, {
        auth: { username: XENDIT_SECRET_KEY, password: "" },
      })
    );

    if (!res.data || !res.data.id) {
      console.error("❌ Invalid invoice response:", res.data);
      return null;
    }

    return res.data;
  } catch (err) {
    console.error("❌ Gagal ambil invoice details:", err.response?.data || err.message);
    return null;
  }
}

// ========================
// ✅ Payment channel logos & limits
// ========================
function Listpaymentchanel() {
  const CHANNEL_LOGOS = {
    AKULAKU:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Payment%20Channel/Financing/Akulaku.png",
    ALFAMART:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Payment%20Channel/Supermarket/Alfamart.png",
    ASTRAPAY:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/refs/heads/main/Bill%20Payment/E-Wallet/Astra%20Pay.png",
    BCA:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Bank/Bank%20Logo/BCA.png",
    BJB:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Bank/Bank%20Logo/BJB.png",
    BNC:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Bank/Bank%20Logo/BNC.png",
    BNI:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Bank/Bank%20Logo/BNI.png",
    BRI_DIRECT_DEBIT:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Bank/Bank%20Logo/BRI.png",
    BRI:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Bank/Bank%20Logo/BRI.png",
    BSI:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Bank/Bank%20Logo/BSI.png",
    CIMB:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Bank/Bank%20Logo/CIMB%20Niaga.png",
    DANA:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/refs/heads/main/Payment%20Channel/E-Wallet/DANA.png",
    GOPAY:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Payment%20Channel/E-Wallet/Gopay.png",
    GOPAY_RECURRING:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Payment%20Channel/E-Wallet/Gopay.png",
    INDODANA:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Payment%20Channel/Financing/Indodana.png",
    INDOMARET:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Payment%20Channel/Supermarket/Indomaret.png",
    KREDIVO:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Payment%20Channel/Financing/Kredivo.png",
    LINKAJA:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Payment%20Channel/E-Wallet/LinkAja.png",
    MANDIRI:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Bank/Bank%20Logo/Mandiri.png",
    OVO:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Payment%20Channel/E-Wallet/OVO.png",
    PERMATA:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/main/Bank/Bank%20Logo/Permata.png",
    QRIS:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/58ae1c43cfe5c57bb2032c85bf9aa58fdfabf9c8/Payment%20Channel/Miscellaneous/QRIS.svg",
    SHOPEEPAY:
      "https://raw.githubusercontent.com/Adekabang/indonesia-logo-library/refs/heads/main/Payment%20Channel/E-Wallet/Shopee%20Pay.png",
  };

  const CHANNEL_LIMITS = {
    AKULAKU: { min_amount: 1000, max_amount: 25000000 },
    ALFAMART: { min_amount: 10000, max_amount: 5000000 },
    ASTRAPAY: { min_amount: 100, max_amount: 20000000 },
    BCA: { min_amount: 10000, max_amount: 50000000 },
    BJB: { min_amount: 1, max_amount: 2000000000 },
    BNC: { min_amount: 1, max_amount: 50000000000 },
    BNI: { min_amount: 1, max_amount: 50000000 },
    BRI_DIRECT_DEBIT: { min_amount: 1, max_amount: 50000000 },
    BRI: { min_amount: 1, max_amount: 50000000000 },
    BSI: { min_amount: 1, max_amount: 50000000000 },
    CIMB: { min_amount: 1, max_amount: 50000000 },
    DANA: { min_amount: 100, max_amount: 20000000 },
    GOPAY: { min_amount: 1, max_amount: 50000000 },
    GOPAY_RECURRING: { min_amount: 1, max_amount: 50000000 },
    INDODANA: { min_amount: 10000, max_amount: 25000000 },
    INDOMARET: { min_amount: 10000, max_amount: 2500000 },
    KREDIVO: { min_amount: 1000, max_amount: 30000000 },
    LINKAJA: { min_amount: 100, max_amount: 10000000 },
    MANDIRI: { min_amount: 1, max_amount: 50000000000 },
    OVO: { min_amount: 100, max_amount: 20000000 },
    PERMATA: { min_amount: 1, max_amount: 9999999999 },
    QRIS: { min_amount: 1, max_amount: 10000000 },
    SHOPEEPAY: { min_amount: 1, max_amount: 20000000 },
  };

  return { CHANNEL_LOGOS, CHANNEL_LIMITS };
}

module.exports = { getXenditMode, getXenditChannels, getXenditInvoice, Listpaymentchanel };
