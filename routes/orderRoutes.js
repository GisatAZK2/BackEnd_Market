const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const sendOrderNotification = require("../utils/email");
const detectspam = require("../middleware/detectSpam");
const verifyCaptcha = require("../middleware/verifyCaptcha");
const {
  attachVariantsStockDiscountWithRealDiscount,
} = require("../utils/applyDiscountAndVariants");

const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

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

router.post("/cart/checkout", detectspam, verifyCaptcha, async (req, res) => {
  const startTime = Date.now();
  try {
    const { itemsToCheckout, pickupMethod } = req.body;
    const userInfo = req.cookies?.user_info
      ? JSON.parse(req.cookies.user_info)
      : null;

    if (!itemsToCheckout?.length) {
      return res
        .status(400)
        .json({ message: "⚠️ Tidak ada item untuk di-checkout." });
    }

    // Cek alamat lengkap untuk user login
    if (userInfo?.id) {
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select(
          "alamat_lengkap, provinsi, kota_kabupaten, kecamatan, kelurahan, kode_pos, nama_penerima, no_telepon",
        )
        .eq("id", userInfo.id)
        .single();

      if (userError) {
        return res.status(500).json({
          message: "❌ Gagal memeriksa data alamat.",
          error: userError.message,
        });
      }

      const {
        alamat_lengkap,
        provinsi,
        kota_kabupaten,
        kecamatan,
        kelurahan,
        kode_pos,
        nama_penerima,
        no_telepon,
      } = userData || {};

      const isAlamatLengkap =
        alamat_lengkap &&
        provinsi &&
        kota_kabupaten &&
        kecamatan &&
        kelurahan &&
        kode_pos &&
        nama_penerima &&
        no_telepon;

      if (!isAlamatLengkap && pickupMethod?.toLowerCase() === "diantar") {
        return res.status(400).json({
          message:
            "⚠️ Lengkapi alamat pengiriman terlebih dahulu sebelum checkout.",
          needUpdateAddress: true,
        });
      }
    }

    // Ambil semua data produk
    const productIds = [
      ...new Set(itemsToCheckout.map((item) => item.productId)),
    ];
    const cacheKeyProducts = `products:${productIds.sort().join(",")}`;

    let products = cache.get(cacheKeyProducts);
    if (!products) {
      let { data, error } = await supabase
        .from("products")
        .select("*")
        .in("id", productIds);

      if (error || !data?.length) {
        return res
          .status(500)
          .json({ message: "❌ Gagal mengambil data produk.", error });
      }

      products = await attachVariantsStockDiscountWithRealDiscount(data);
      cache.set(cacheKeyProducts, products);
    }

    const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

    // Kelompokkan berdasarkan seller
    const sellerGroups = {};
    for (const item of itemsToCheckout) {
      const product = productMap[item.productId];
      if (!product) continue;

      const variant = product.variants?.find((v) => v.id === item.variantId);
      const finalPrice = variant?.final_price ?? product.finalPrice;

      if (!sellerGroups[product.seller_id])
        sellerGroups[product.seller_id] = [];
      sellerGroups[product.seller_id].push({
        ...item,
        product,
        variant,
        finalPrice,
      });
    }

    const createdOrders = [];

    // Ambil seller info (dengan delivery_fee)
    const sellerIds = Object.keys(sellerGroups);
    const cacheKeySellers = `sellers:${sellerIds.sort().join(",")}`;

    let sellerData = cache.get(cacheKeySellers);
    if (!sellerData) {
      const { data } = await supabase
        .from("sellers")
        .select("id, store_name, email, delivery_fee")
        .in("id", sellerIds);
      sellerData = data || [];
      cache.set(cacheKeySellers, sellerData);
    }

    const sellerMap = Object.fromEntries(sellerData.map((s) => [s.id, s]));

    // Buat semua order
    for (const [sellerId, items] of Object.entries(sellerGroups)) {
      const baseTotal = items.reduce((sum, i) => sum + i.finalPrice * i.qty, 0);

      let deliveryFee = 0;
      let totalPrice = baseTotal;

      if (pickupMethod?.toLowerCase() === "diantar") {
        deliveryFee = sellerMap[sellerId]?.delivery_fee || 0;
        totalPrice += deliveryFee;
      }

      const orderPayload = {
        user_id: userInfo?.id || null,
        seller_id: sellerId,
        pickup_method: pickupMethod,
        status: "pending",
        total_price: totalPrice,
      };

      if (pickupMethod?.toLowerCase() === "diantar") {
        orderPayload.delivery_fee = deliveryFee;
      } else {
        // hanya pickup yang punya deadline
        orderPayload.pickup_deadline = new Date(
          Date.now() + 6 * 60 * 60 * 1000,
        ).toISOString();
      }

      const { data: order, error: orderError } = await supabase
        .from("orders")
        .insert([orderPayload])
        .select()
        .single();

      if (orderError) {
        console.error(
          `❌ Gagal membuat order seller ${sellerId}:`,
          orderError.message,
        );
        continue;
      }

      const orderItems = items.map((item) => ({
        order_id: order.id,
        product_id: item.productId,
        variant_id: item.variantId || null,
        quantity: item.qty,
        price_per_item: item.finalPrice,
      }));

      await supabase.from("order_items").insert(orderItems);
      createdOrders.push({ order, items: orderItems });

      // Kirim email
      if (userInfo) {
        const seller = sellerMap[sellerId];
        sendOrderNotification({
          order_id: order.id,
          products: items.map((i) => ({
            product_name: i.product.product_name,
            variant_name: i.variant?.variant_name || null,
            quantity: i.qty,
            total_price: i.finalPrice * i.qty,
            product_image_url:
              i.variant?.variant_image_url ||
              safeParseImageUrl(i.product.product_image_url),
          })),
          buyer_email: userInfo.email,
          seller_email: seller?.email,
          buyer_username: userInfo.username,
        });
      }
    }

    // Hapus item checkout dari cart
    if (userInfo?.id) {
      const { data: cart } = await supabase
        .from("carts")
        .select("items")
        .eq("user_id", userInfo.id)
        .maybeSingle();

      if (cart?.items?.length) {
        const remainingItems = cart.items.filter(
          (cartItem) =>
            !itemsToCheckout.some(
              (checkoutItem) =>
                checkoutItem.productId === cartItem.productId &&
                (checkoutItem.variantId || null) ===
                  (cartItem.variantId || null),
            ),
        );

        await supabase
          .from("carts")
          .update({ items: remainingItems })
          .eq("user_id", userInfo.id);
      }
    }

    const endTime = Date.now();
    return res.status(200).json({
      message: `✅ Berhasil checkout ${createdOrders.length} order. (⏱ ${
        (endTime - startTime) / 1000
      }s)`,
      orders: createdOrders.map((o) => o.order),
    });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res
      .status(500)
      .json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// === List semua order milik user login ===
router.get("/cart/orders", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info
      ? JSON.parse(req.cookies.user_info)
      : null;

    if (!userInfo?.id) {
      return res
        .status(401)
        .json({ message: "❌ Harus login untuk melihat daftar order." });
    }

    const { data: orders, error } = await supabase
      .from("orders")
      .select("*, users(*)") // ambil info user
      .eq("user_id", userInfo.id)
      .order("created_at", { ascending: false });

    if (error) {
      return res
        .status(500)
        .json({ message: "❌ Gagal mengambil data order.", error });
    }

    return res.status(200).json({
      message: "✅ Daftar order berhasil diambil.",
      user_info: userInfo,
      orders,
    });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res
      .status(500)
      .json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// === Get detail order by ID ===
router.get("/cart/orders/:id", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info
      ? JSON.parse(req.cookies.user_info)
      : null;

    if (!userInfo?.id) {
      return res
        .status(401)
        .json({ message: "❌ Harus login untuk melihat detail order." });
    }

    const { id } = req.params;

    // Ambil order + items + produk
    const { data: order, error } = await supabase
      .from("orders")
      .select(
        `
        *,
        users(*),
        order_items(
          *,
          products(*),
          variants(*)
        )
      `,
      )
      .eq("id", id)
      .eq("user_id", userInfo.id) // pastikan order milik user ini
      .single();

    if (error || !order) {
      return res.status(404).json({
        message: "❌ Order tidak ditemukan.",
        error: error?.message,
      });
    }

    return res.status(200).json({
      message: "✅ Detail order berhasil diambil.",
      user_info: userInfo,
      order,
    });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res
      .status(500)
      .json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

module.exports = router;
