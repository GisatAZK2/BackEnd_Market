const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const sendOrderNotification = require("../utils/email");
const detectspam = require("../middleware/detectSpam");
const verifyCaptcha = require("../middleware/verifyCaptcha");
const {
  attachVariantsStockDiscountWithRealDiscount,
} = require("../utils/applyDiscountAndVariants");
const { DateTime } = require("luxon");


const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
const orderCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });

// Helper: parsing aman untuk URL gambar
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


// === DELIVERY FEE ===
router.post("/cart/delivery-fee", async (req, res) => {

  // Bisa Ditambahkan Payment Gateway

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
        .select("id, store_name, delivery_fee")
        .in("id", sellerIds);

      if (error) {
        return res.status(500).json({
          message: "❌ Gagal mengambil data seller.",
          error: error.message,
        });
      }

      sellers = data;
      cache.set(cacheKeySellers, sellers);
    }

    // Map seller buat akses O(1)
    const sellerMap = new Map(sellers.map((s) => [s.id, s]));

    // Group items per seller-method menggunakan reduce
    const groupedOrders = itemsToCheckout.reduce((acc, item) => {
      const product = productMap.get(item.productId);
      if (!product) return acc;

      // Kalau ada pickupMethod root, override semua item jadi itu
      const method = (
        pickupMethod ||
        item.pickupMethod ||
        "diambil"
      ).toLowerCase();

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

        const delivery_fee =
          group.pickup_method === "diantar" ? seller.delivery_fee || 0 : 0;

        return {
          seller_id: seller.id,
          store_name: seller.store_name,
          pickup_method: group.pickup_method,
          total_produk: totalProduk,
          delivery_fee,
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

    return res.status(200).json({
      message: "✅ Data checkout berhasil dihitung.",
      sellers: resultPerGroup,
      total_produk_semua: grandTotalProduk,
      total_ongkir_semua: grandTotalOngkir,
      total_checkout_semua: grandTotalSemua,
    });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server.",
      error: err.message,
    });
  }
});


// Fungsi bantu untuk hitung persen diskon dari harga dasar dan harga diskon
function calculateDiscountFromPrice(basePrice, discountedPrice) {
  if (!basePrice || !discountedPrice || basePrice === 0) return 0;
  const discount = ((basePrice - discountedPrice) / basePrice) * 100;
  return discount > 0 ? discount : 0;
}

function combineFullAddress(user) {
  return `${user.alamat_lengkap}, Kec. ${user.kecamatan}, Kel. ${user.kelurahan}, ${user.kota_kabupaten}, ${user.provinsi}, Kode Pos: ${user.kode_pos}`;
}

// Route GET /all - daftar order user
router.get("/all", async (req, res) => {
  try {
    // ✅ Ambil info user dari cookie
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id)
      return res.status(401).json({ message: "❌ Harus login untuk melihat daftar order." });

    const cacheKey = `orders:list:${userInfo.id}`;
    let orders = orderCache.get(cacheKey);
    if (orders)
      return res.status(200).json({ message: "✅ Daftar order berhasil diambil (cache).", orders });

    // ✅ Ambil semua order user
    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, pickup_deadline")
      .eq("user_id", userInfo.id)
      .order("created_at", { ascending: false });
    if (orderError)
      return res.status(500).json({ message: "❌ Gagal mengambil data order.", error: orderError });

    const orderIds = ordersData.map(o => o.id);

    // ✅ Ambil order_items untuk quantity
    const { data: orderItems, error: orderItemsError } = await supabase
      .from("order_items")
      .select("order_id, product_id, variant_id, quantity")
      .in("order_id", orderIds);
    if (orderItemsError)
      return res.status(500).json({ message: "❌ Gagal mengambil order items.", error: orderItemsError });

    // ✅ Buat lookup quantity cepat
    const orderItemMap = {};
    orderItems.forEach(oi => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      orderItemMap[key] = oi.quantity ?? 0;
    });

    // ✅ Ambil detail produk
    const { data: detailItems, error: detailError } = await supabase
      .from("order_details_items")
      .select("*")
      .in("order_id", orderIds);
    if (detailError)
      return res.status(500).json({ message: "❌ Gagal mengambil detail order.", error: detailError });

    // ✅ Ambil info buyer
    const { data: buyerData } = await supabase
      .from("users")
      .select("nama_penerima, no_telepon, alamat_lengkap, provinsi, kota_kabupaten, kecamatan, kelurahan, kode_pos")
      .eq("id", userInfo.id)
      .single();

    // ✅ Hitung total_quantity per order
    const qtyByOrder = {};
    orderItems.forEach(item => {
      if (!qtyByOrder[item.order_id]) qtyByOrder[item.order_id] = 0;
      qtyByOrder[item.order_id] += item.quantity ?? 0;
    });

    // ✅ Map detailItems per order
    const itemsByOrder = {};
    detailItems.forEach(item => {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];

      const key = `${item.order_id}-${item.product_id}-${item.variant_id ?? "null"}`;
      const quantity = orderItemMap[key] ?? 0;

      itemsByOrder[item.order_id].push({
        order_item_id: item.order_item_id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity,
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

    // ✅ Gabungkan orders + items + total_quantity + buyer info
    orders = ordersData.map(order => ({
      ...order,
      order_items: itemsByOrder[order.id] || [],
      total_quantity: qtyByOrder[order.id] || 0,
      buyer_info: buyerData || null,
      buyer_full_address: buyerData ? combineFullAddress(buyerData) : null,
    }));

    // ✅ Set cache
    orderCache.set(cacheKey, orders);

    return res.status(200).json({ message: "✅ Daftar order berhasil diambil.", orders });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// Route GET /:id - detail order + buyer info
router.get("/:id", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) return res.status(401).json({ message: "❌ Harus login." });

    const orderId = req.params.id;
    const cacheKey = `order:detail:${userInfo.id}:${orderId}`;
    let cached = orderCache.get(cacheKey);
    if (cached) return res.status(200).json({ message: "✅ Order diambil (cache).", order: cached });

    // Ambil data order
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .select("id, user_id, created_at, total_price, delivery_fee, status, pickup_method, pickup_deadline")
      .eq("id", orderId)
      .single();

    if (orderError || !orderData) return res.status(404).json({ message: "❌ Order tidak ditemukan.", error: orderError });

    // Ambil detail item dari snapshot
    const { data: detailItems, error: detailError } = await supabase
      .from("order_detail_items")
      .select("*")
      .eq("order_id", orderId);

    if (detailError) return res.status(500).json({ message: "❌ Gagal mengambil detail order.", error: detailError });

    // Ambil info buyer
    const { data: buyerData } = await supabase
      .from("users")
      .select("nama_penerima, no_telepon, alamat_lengkap, provinsi, kota_kabupaten, kecamatan, kelurahan, kode_pos")
      .eq("id", orderData.user_id)
      .single();

    // Mapping snapshot item sesuai struktur checkout
    const mappedItems = detailItems.map(item => ({
      order_item_id: item.order_item_id,
      product_id: item.product_id,
      product_name: item.product_name,
      product_image_url: safeParseImageUrl(item.product_image_url),
      quantity: item.quantity,
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
    }));

    const orderResponse = {
      id: orderData.id,
      created_at: orderData.created_at,
      total_price: orderData.total_price,
      delivery_fee: orderData.delivery_fee,
      status: orderData.status,
      pickup_method: orderData.pickup_method,
      pickup_deadline: orderData.pickup_deadline,
      order_items: mappedItems,
      buyer_info: buyerData || null,
      buyer_full_address: buyerData ? combineFullAddress(buyerData) : null,
    };

    orderCache.set(cacheKey, orderResponse);
    return res.status(200).json({ message: "✅ Order detail berhasil diambil.", order: orderResponse });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});




module.exports = router;
