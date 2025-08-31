const express = require("express");
const supabase = require("../../config/supabase");
const { DateTime } = require("luxon");
const NodeCache = require("node-cache");

const router = express.Router();
const statsCache = new NodeCache(); // we'll set TTL per-key dynamically

// helper: parse range
function parseRangeQuery(q) {
  if (!q) return { type: "days", days: 7 };
  q = String(q).toLowerCase();
  if (q === "1week" || q === "7days") return { type: "days", days: 7 };
  if (q === "7weeks") return { type: "weeks", weeks: 7 };
  if (q === "1year" || q === "year") return { type: "years", years: 1 };
  const m = q.match(/^(\d+)(days|day)$/);
  if (m) return { type: "days", days: Number(m[1]) };
  return { type: "days", days: 7 };
}

// helper: seconds until next midnight in Asia/Jakarta
function secondsUntilTomorrowJakarta() {
  const now = DateTime.now().setZone("Asia/Jakarta");
  const tomorrow = now.plus({ days: 1 }).startOf("day");
  return Math.max(60, Math.floor(tomorrow.diff(now, "seconds").seconds)); // at least 60s
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


router.get("/history-order-by-day", async (req, res) => {
  try {
    // 1) identify seller
    const cookieSeller = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
    const cookieUser = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    const sellerId = (cookieSeller && cookieSeller.id) || req.query.seller_id || (cookieUser && cookieUser.seller_id);

    if (!sellerId) return res.status(401).json({ message: "❌ Harus login sebagai seller atau sertakan seller_id." });

    // 2) parse date range (sama seperti sebelumnya)
    let startDate, endDate;
    const { start, end, days } = req.query;
    if (start && end) {
      startDate = DateTime.fromISO(start, { zone: "Asia/Jakarta" }).startOf("day");
      endDate = DateTime.fromISO(end, { zone: "Asia/Jakarta" }).endOf("day");
      if (!startDate.isValid || !endDate.isValid) {
        return res.status(400).json({ message: "❌ Format tanggal tidak valid. Gunakan YYYY-MM-DD." });
      }
    } else if (req.query.range || days) {
      const rangeSpec = parseRangeQuery(req.query.range || `${days}days`);
      endDate = DateTime.now().setZone("Asia/Jakarta").endOf("day");
      if (rangeSpec.type === "days") {
        startDate = endDate.minus({ days: rangeSpec.days - 1 }).startOf("day");
      } else if (rangeSpec.type === "weeks") {
        startDate = endDate.minus({ weeks: rangeSpec.weeks }).startOf("day");
      } else if (rangeSpec.type === "years") {
        startDate = endDate.minus({ years: rangeSpec.years }).startOf("day");
      } else {
        startDate = endDate.minus({ days: 6 }).startOf("day");
      }
    } else {
      endDate = DateTime.now().setZone("Asia/Jakarta").endOf("day");
      startDate = endDate.minus({ days: 6 }).startOf("day");
    }

    const cacheKey = `seller_stats:${sellerId}:${startDate.toISODate()}:${endDate.toISODate()}`;
    const cached = statsCache.get(cacheKey);
    if (cached) {
      return res.status(200).json({ message: "✅ Statistik (cache).", ...cached });
    }

    // === ambil summary dari seller_daily_stats ===
    const { data: statsRowsRaw, error: statsError } = await supabase
      .from("seller_daily_stats")
      .select("date, orders_count, new_customers_count, total_sales")
      .eq("seller_id", sellerId)
      .gte("date", startDate.toISODate())
      .lte("date", endDate.toISODate())
      .order("date", { ascending: true });

    if (statsError) {
      console.error("❌ Gagal ambil data summary:", statsError);
      return res.status(500).json({ message: "❌ Gagal ambil data summary.", error: statsError.message || statsError });
    }

    const statsRows = statsRowsRaw || [];

    // buat map cepat: date(YYYY-MM-DD) => row
    const statsMap = {};
    statsRows.forEach(r => {
      const key = DateTime.fromISO(String(r.date), { zone: "Asia/Jakarta" }).toISODate();
      statsMap[key] = {
        orders_count: Number(r.orders_count || 0),
        new_customers_count: Number(r.new_customers_count || 0),
        total_sales: Number(r.total_sales || 0)
      };
    });

    // isi per-day dari startDate..endDate (termasuk hari tanpa data)
    const perDay = [];
    let cursor = startDate;
    let cumulativeSales = 0;
    let cumulativeOrders = 0;
    while (cursor <= endDate) {
      const key = cursor.toISODate();
      const row = statsMap[key] || { orders_count: 0, new_customers_count: 0, total_sales: 0 };
      cumulativeSales += Number(row.total_sales || 0);
      cumulativeOrders += Number(row.orders_count || 0);

      perDay.push({
        date: key,
        orders_count: row.orders_count,
        new_customers_count: row.new_customers_count,
        total_sales: +Number(row.total_sales).toFixed(2),
        cumulative_sales: +cumulativeSales.toFixed(2),
        cumulative_orders: cumulativeOrders
      });

      cursor = cursor.plus({ days: 1 });
    }

    // 9) summary stats for period (gunakan perDay, bukan sortedDates)
    const totalOrders = perDay.reduce((s, r) => s + r.orders_count, 0);
    const totalNewCustomers = perDay.reduce((s, r) => s + r.new_customers_count, 0);
    const totalSales = perDay.reduce((s, r) => s + r.total_sales, 0);

    const payload = {
      seller_id: sellerId,
      range: { start: startDate.toISODate(), end: endDate.toISODate() },
      summary: {
        total_days: perDay.length,
        total_orders: totalOrders,
        total_new_customers: totalNewCustomers,
        total_sales: +totalSales.toFixed(2),
      },
      per_day: perDay
    };

    // cache until Jakarta midnight
    const ttl = secondsUntilTomorrowJakarta();
    statsCache.set(cacheKey, payload, ttl);

    return res.status(200).json({ message: "✅ Statistik berhasil diambil.", ...payload });
  } catch (err) {
    console.error("❌ Server error /history-order-by-day:", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server.", error: err.message || err });
  }
});

// ======================
// GET Order Seller Hari Ini (Detail + Cache)
// ======================
router.get("/order/daily", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller untuk melihat order harian." });
    }

    const zone = "Asia/Jakarta";
    const startOfDay = DateTime.now().setZone(zone).startOf("day").toISO();
    const endOfDay = DateTime.now().setZone(zone).endOf("day").toISO();

    const cacheKey = `orders:seller:daily:${sellerInfo.id}:${startOfDay}`;
    let orders = statsCache.get(cacheKey);
    if (orders) {
      return res.status(200).json({ message: "✅ Daftar order harian berhasil diambil (cache).", orders });
    }

    // 🔹 Ambil order hari ini
    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, status, buyer_address") // ambil secukupnya
      .eq("seller_id", sellerInfo.id)
      .gte("created_at", startOfDay)
      .lte("created_at", endOfDay)
      .order("created_at", { ascending: false });

    if (orderError) {
      return res.status(500).json({ message: "❌ Gagal mengambil data order harian seller.", error: orderError });
    }

    const orderIds = ordersData.map(o => o.id);
    if (!orderIds.length) {
      return res.status(200).json({ message: "✅ Tidak ada order hari ini.", orders: [] });
    }

    // 🔹 Ambil order_items
    const { data: detailItems, error: detailError } = await supabase
      .from("order_details_items")
      .select("*")
      .in("order_id", orderIds);

    if (detailError) {
      return res.status(500).json({ message: "❌ Gagal mengambil detail items.", error: detailError });
    }

    // 🔹 Map items per order
    const itemsByOrder = {};
    (detailItems || []).forEach(item => {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];

      itemsByOrder[item.order_id].push({
        order_item_id: item.order_item_id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity: item.quantity ?? 0,
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

    // 🔹 Bentuk response final (hanya field yang dibutuhkan)
    orders = ordersData.map(order => {
      let buyerInfo = null;
      if (order.buyer_address) {
        try {
          buyerInfo = typeof order.buyer_address === "string"
            ? JSON.parse(order.buyer_address)
            : order.buyer_address;
        } catch (e) {
          console.warn("⚠️ Gagal parse buyer_address:", order.buyer_address);
        }
      }

      return {
        id: order.id,
        status: order.status,
        created_at: order.created_at,
        buyer_info: {
          username: buyerInfo?.username ?? null
        },
        order_items: itemsByOrder[order.id] || []
      };
    });

    // 🔹 Cache hasil
    statsCache.set(cacheKey, orders);

    return res.status(200).json({
      message: "✅ Daftar order harian seller berhasil diambil.",
      orders,
      range: { startOfDay, endOfDay }
    });
  } catch (err) {
    console.error("❌ Server error (order/daily):", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server.", error: err.message });
  }
});

module.exports = router;