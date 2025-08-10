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

// === List semua order milik user login (pakai cache) ===
router.get("/all", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info
      ? JSON.parse(req.cookies.user_info)
      : null;

    if (!userInfo?.id) {
      return res
        .status(401)
        .json({ message: "❌ Harus login untuk melihat daftar order." });
    }

    const cacheKey = `orders:list:${userInfo.id}`;
    let orders = orderCache.get(cacheKey);

    if (!orders) {
      const { data: ordersData, error } = await supabase
        .from("orders")
        .select(
          `
          id,
          created_at,
          total_price,
          delivery_fee,
          status,
          pickup_method,
          pickup_deadline,
          order_items (
            id,
            product_id,
            variant_id,
            quantity,
            products (
              id,
              product_name,
              product_image_url
            )
          )
        `,
        )
        .eq("user_id", userInfo.id)
        .order("created_at", { ascending: false });

      if (error) {
        return res
          .status(500)
          .json({ message: "❌ Gagal mengambil data order.", error });
      }

      const allProducts = [];
      ordersData.forEach((order) => {
        order.order_items.forEach((item) => {
          if (item.products) {
            allProducts.push(item.products);
          }
        });
      });

      const uniqueProducts = [
        ...new Map(allProducts.map((p) => [p.id, p])).values(),
      ];

      const enrichedProducts =
        await attachVariantsStockDiscountWithRealDiscount(uniqueProducts);

      orders = ordersData.map((order) => ({
        id: order.id,
        created_at: order.created_at,
        total_price: order.total_price,
        delivery_fee:
          order.pickup_method === "diantar" ? order.delivery_fee : 0,
        status: order.status,
        pickup_method: order.pickup_method,
        pickup_deadline: order.pickup_deadline,
        order_items: order.order_items.map((item) => {
          const product = enrichedProducts.find(
            (p) => p.id === item.product_id,
          );
          return {
            id: item.id,
            quantity: item.quantity,
            variant_id: item.variant_id,
            product: product || null,
          };
        }),
      }));

      orderCache.set(cacheKey, orders);
    }

    return res.status(200).json({
      message: "✅ Daftar order berhasil diambil.",
      orders,
      cache: !!orderCache.get(cacheKey),
    });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res
      .status(500)
      .json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// === Get detail order by ID (pakai cache) ===
// === Get detail order by ID (pakai cache) ===
router.get("/:id", async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info
      ? JSON.parse(req.cookies.user_info)
      : null;

    if (!userInfo?.id) {
      return res
        .status(401)
        .json({ message: "❌ Harus login untuk melihat order." });
    }

    const orderId = req.params.id;
    const cacheKey = `order:${userInfo.id}:${orderId}`;

    // Cek cache
    let orderResponse = orderCache.get(cacheKey);
    if (orderResponse) {
      return res.status(200).json({
        message: "✅ Order berhasil diambil (cache).",
        order: orderResponse,
      });
    }

    // Ambil 1 order + item yang dipesan + produk (hanya kolom perlu)
    const { data: orderData, error } = await supabase
      .from("orders")
      .select(
        `
        id,
        created_at,
        total_price,
        delivery_fee,
        status,
        pickup_method,
        pickup_deadline,
        order_items (
          id,
          product_id,
          variant_id,
          quantity,
          products (
            id,
            product_name,
            product_image_url
          )
        )
      `,
      )
      .eq("user_id", userInfo.id)
      .eq("id", orderId)
      .single();

    if (error) {
      return res
        .status(500)
        .json({ message: "❌ Gagal mengambil data order.", error });
    }
    if (!orderData) {
      return res.status(404).json({ message: "❌ Order tidak ditemukan." });
    }

    // Ambil semua produk unik dan enrich sekaligus
    const productMap = {};
    orderData.order_items.forEach((item) => {
      if (item.products && !productMap[item.products.id]) {
        productMap[item.products.id] = item.products;
      }
    });

    const enrichedProducts = await attachVariantsStockDiscountWithRealDiscount(
      Object.values(productMap),
    );
    const enrichedMap = Object.fromEntries(
      enrichedProducts.map((p) => [p.id, p]),
    );

    // Mapping item langsung
    const mappedItems = orderData.order_items
      .map((item) => {
        const productData = enrichedMap[item.product_id];
        if (!productData) return null;

        if (item.variant_id) {
          const variantData = productData.variants?.find(
            (v) => v.id === item.variant_id,
          );
          return {
            type: "variant",
            id_product: productData.id,
            id: variantData?.id || null,
            product_name: productData.product_name,
            variant_name: variantData?.variant_name || null,
            variant_image_url: variantData?.variant_image_url || null,
            quantity: item.quantity,
            original_price: variantData?.price || 0,
            applied_discount: variantData?.discount || 0,
            final_price:
              variantData?.finalPrice ??
              Math.max(
                0,
                variantData?.price -
                  (variantData?.price * (variantData?.discount || 0)) / 100,
              ),
          };
        }

        return {
          type: "single",
          id_product: productData.id,
          product_name: productData.product_name,
          product_image_url: productData.product_image_url,
          quantity: item.quantity,
          product_price: productData.price,
          discountPercentage: productData.discount || 0,
          finalPrice:
            productData.finalPrice ??
            Math.max(
              0,
              productData.price -
                (productData.price * (productData.discount || 0)) / 100,
            ),
        };
      })
      .filter(Boolean);

    // Buat response
    orderResponse = {
      id: orderData.id,
      created_at: orderData.created_at,
      total_price: orderData.total_price,
      delivery_fee: orderData.delivery_fee,
      status: orderData.status,
      order_items: mappedItems,
    };

    if (orderData.pickup_method === "diambil") {
      orderResponse.pickup_deadline = orderData.pickup_deadline;
    }

    // Simpan ke cache
    orderCache.set(cacheKey, orderResponse);

    return res
      .status(200)
      .json({ message: "✅ Order berhasil diambil.", order: orderResponse });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res
      .status(500)
      .json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

module.exports = router;
