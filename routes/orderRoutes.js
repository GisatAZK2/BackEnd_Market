const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const sendOrderNotification = require("../utils/email");
const detectspam = require("../middleware/detectSpam");
const verifyCaptcha = require("../middleware/verifyCaptcha");
const multer = require("multer");
const {
  attachVariantsStockDiscountWithRealDiscount,
} = require("../utils/applyDiscountAndVariants");
const { DateTime } = require("luxon");


const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
const orderCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
const upload = multer({ storage: multer.memoryStorage() });

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
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

    if (!itemsToCheckout?.length)
      return res.status(400).json({ message: "⚠️ Tidak ada item untuk di-checkout." });

    // ==========================
    // 🔹 Ambil buyer info
    // ==========================
    let buyerAddress = null;
    if (userInfo?.id) {
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select(`
          alamat_lengkap,
          provinsi,
          kota_kabupaten,
          kecamatan,
          kelurahan,
          kode_pos,
          nama_penerima,
          no_telepon,
          email,
          username
        `)
        .eq("id", userInfo.id)
        .single();

      if (userError) {
        return res.status(500).json({
          message: "❌ Gagal memeriksa data buyer.",
          error: userError.message,
        });
      }

      const adaDiantar = itemsToCheckout.some(
        (item) => (item.pickupMethod || pickupMethod)?.toLowerCase() === "diantar"
      );

      if (adaDiantar) {
        // ✅ kalau ada item "diantar", alamat wajib lengkap
        const isAlamatLengkap =
          userData &&
          Object.values({
            alamat_lengkap: userData.alamat_lengkap,
            provinsi: userData.provinsi,
            kota_kabupaten: userData.kota_kabupaten,
            kecamatan: userData.kecamatan,
            kelurahan: userData.kelurahan,
            kode_pos: userData.kode_pos,
            nama_penerima: userData.nama_penerima,
            no_telepon: userData.no_telepon,
          }).every(Boolean);

        if (!isAlamatLengkap) {
          return res.status(400).json({
            message: "⚠️ Lengkapi alamat pengiriman terlebih dahulu.",
            needUpdateAddress: true,
          });
        }
      }

      // 🔹 Simpan buyer info untuk semua pickup_method
      buyerAddress = userData;
    }

    // ==========================
    // 🔹 Ambil produk + varian
    // ==========================
    const productIds = [...new Set(itemsToCheckout.map((i) => i.productId))];
    const cacheKeyProducts = `products:${productIds.sort().join(",")}`;
    let products = cache.get(cacheKeyProducts);

    if (!products) {
      const [productRowsRes, variantRowsRes] = await Promise.all([
        supabase.from("products").select("*").in("id", productIds),
        supabase.from("product_variants").select("*").in("product_id", productIds),
      ]);

      if (!productRowsRes.data?.length)
        return res
          .status(500)
          .json({ message: "❌ Gagal mengambil data produk.", error: productRowsRes.error });
      if (variantRowsRes.error)
        return res
          .status(500)
          .json({ message: "❌ Gagal mengambil varian.", error: variantRowsRes.error });

      products = productRowsRes.data.map((p) => ({
        ...p,
        variants: variantRowsRes.data.filter((v) => v.product_id === p.id),
      }));

      products = await attachVariantsStockDiscountWithRealDiscount(products);
      cache.set(cacheKeyProducts, products);
    }

    const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

    // ==========================
    // 🔹 Group order per seller
    // ==========================
    const orderGroups = {};
    itemsToCheckout.forEach((item) => {
      const product = productMap[item.productId];
      if (!product) return;
      const variant = product.variants?.find((v) => v.id === item.variantId);
      const finalPrice = variant?.final_price ?? product.finalPrice;
      const method = (item.pickupMethod || pickupMethod || "diantar").toLowerCase();
      const groupKey = `${product.seller_id}-${method}`;
      if (!orderGroups[groupKey])
        orderGroups[groupKey] = { seller_id: product.seller_id, pickup_method: method, items: [] };
      orderGroups[groupKey].items.push({
        ...item,
        product,
        variant,
        finalPrice,
        discountPercentage: product.discount_percentage ?? 0,
        variantDiscountPercentage: variant?.applied_discount ?? 0,
      });
    });

    // ==========================
    // 🔹 Ambil seller data
    // ==========================
    const sellerIds = [...new Set(Object.values(orderGroups).map((g) => g.seller_id))];
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

    // ==========================
    // 🔹 Insert orders paralel
    // ==========================
    const createdOrders = await Promise.all(
      Object.values(orderGroups).map(async (group) => {
        const { seller_id, pickup_method, items } = group;
        const baseTotal = items.reduce((sum, i) => sum + i.finalPrice * i.qty, 0);
        const deliveryFee =
          pickup_method === "diantar" ? sellerMap[seller_id]?.delivery_fee || 0 : 0;
        const totalPrice = baseTotal + deliveryFee;
        const confirmDeadline = DateTime.now()
          .setZone("Asia/Jakarta")
          .plus({ minutes: 30 })
          .toISO();

        const { data: order, error: orderError } = await supabase
          .from("orders")
          .insert([
            {
              user_id: userInfo?.id || null,
              seller_id,
              pickup_method,
              status: "pending",
              total_price: totalPrice,
              confirm_deadline: confirmDeadline,
              delivery_fee: deliveryFee,
              buyer_address: buyerAddress || null, // 🔹 selalu ada
            },
          ])
          .select()
          .single();
        if (orderError) return null;

        const orderItems = items.map((i) => ({
          order_id: order.id,
          product_id: i.productId,
          variant_id: i.variantId || null,
          quantity: i.qty,
          price_per_item: i.finalPrice,
        }));
        await supabase.from("order_items").insert(orderItems);

        // Snapshot & email background
        (async () => {
          const snapshotItems = items.map((i) => ({
            order_id: order.id,
            product_id: i.product.id,
            product_name: i.product.product_name,
            product_price: i.product.price,
            final_price: i.finalPrice,
            discount_percentage: i.discountPercentage,
            product_image_url: safeParseImageUrl(i.product.product_image_url),
            variant_id: i.variant?.id || null,
            variant_name: i.variant?.variant_name || null,
            variant_price: i.variant?.price ?? null,
            variant_final_price: i.variant?.final_price ?? null,
            variant_discount_percentage: i.variantDiscountPercentage,
            variant_image_url: i.variant?.variant_image_url || null,
          }));
          await supabase.from("order_item_details").insert(snapshotItems);
          await supabase.from("order_details_items").insert(snapshotItems);

          if (userInfo) {
            await sendOrderNotification({
              order_id: order.id,
              products: items.map((i) => ({
                product_name: i.product.product_name,
                variant_name: i.variant?.variant_name || null,
                quantity: i.qty,
                total_price: i.finalPrice * i.qty,
                product_image_url:
                  i.variant?.variant_image_url || safeParseImageUrl(i.product.product_image_url),
              })),
              buyer_email: userInfo.email,
              seller_email: sellerMap[seller_id]?.email,
              buyer_username: userInfo.username,
              pickup_method,
              new_status: "pending",
            });
          }
        })();

        return { order, items: orderItems };
      })
    );

    // ==========================
    // 🔹 Hapus item dari cart
    // ==========================
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
                (checkoutItem.variantId || null) === (cartItem.variantId || null)
            )
        );
        await supabase.from("carts").update({ items: remainingItems }).eq("user_id", userInfo.id);
      }
    }

    // ==========================
    // 🔹 Response
    // ==========================
    const endTime = Date.now();
    return res.status(200).json({
      message: `✅ Berhasil checkout ${
        createdOrders.filter(Boolean).length
      } order. (⏱ ${(endTime - startTime) / 1000}s)`,
      orders: createdOrders.filter(Boolean).map((o) => o.order),
    });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});


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

router.post("/:id/rating", upload.array("images"), async (req, res) => {
  try {
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login." });
    }

    const orderId = req.params.id;
    const { ratings } = JSON.parse(req.body.data);

    // ✅ ambil orders + order_items
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        id,
        status,
        user_id,
        order_items (id, product_id, variant_id)
      `)
      .eq("id", orderId)
      .single();

    if (orderError || !order) {
      console.error("❌ Gagal ambil order:", orderError);
      return res.status(500).json({ message: "❌ Gagal ambil order." });
    }

    if (String(order.user_id) !== String(userInfo.id)) {
      return res.status(403).json({ message: "⚠️ Tidak punya akses ke order ini." });
    }

    if (order.status !== "diterima") {
      return res.status(400).json({ message: "⚠️ Hanya bisa kasih rating setelah order diterima." });
    }

    // bikin map dari order_items
    const validMap = new Map(
      order.order_items.map(i => [
        String(i.id).toLowerCase(),
        { product_id: i.product_id, variant_id: i.variant_id }
      ])
    );

    // upload images
    const uploadedUrls = [];
    for (const file of req.files) {
      const filePath = `reviews/${Date.now()}_${file.originalname}`;
      const { error: uploadError } = await supabase.storage
        .from("review-images")
        .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: true });

      if (uploadError) {
        console.error("❌ Upload error:", uploadError);
        return res.status(500).json({ message: "❌ Gagal upload gambar." });
      }

      const { data: publicUrl } = supabase.storage
        .from("review-images")
        .getPublicUrl(filePath);

      uploadedUrls.push(publicUrl.publicUrl);
    }

    const resultRatings = [];

    for (const r of ratings) {
      const validItem = validMap.get(String(r.orderItemId).toLowerCase());

      if (
        !validItem ||
        String(validItem.product_id).toLowerCase() !== String(r.productId).toLowerCase()
      ) {
        console.log("⚠️ Rating dilewati karena tidak valid", { r, validItem });
        continue;
      }

      // 🔎 ambil variant_id valid
      let finalVariantId = null;
      if (validItem.variant_id) {
        const { data: variantCheck, error: variantError } = await supabase
          .from("product_variants")
          .select("id")
          .eq("id", validItem.variant_id)
          .eq("product_id", validItem.product_id)
          .maybeSingle();

        if (variantError) {
          console.warn("⚠️ Gagal cek variant:", variantError);
        }
        finalVariantId = variantCheck ? variantCheck.id : null;
      }

      // cek existing rating
      const { data: existing, error: existingError } = await supabase
        .from("ratings")
        .select("id")
        .eq("order_item_id", r.orderItemId)
        .eq("user_id", userInfo.id)
        .maybeSingle();

      if (existingError) {
        console.error("❌ Gagal cek rating lama:", existingError);
        return res.status(500).json({ message: "❌ Gagal cek rating lama." });
      }

      if (existing) {
        return res.status(400).json({
          message: "⚠️ Kamu sudah memberi rating untuk item ini, tidak bisa duplikat."
        });
      }

      // 🔎 ambil detail produk
      const { data: product, error: productError } = await supabase
        .from("products")
        .select("id, product_name, product_image_url")
        .eq("id", r.productId)
        .single();

      if (productError || !product) {
        console.error("❌ Produk tidak ditemukan:", productError);
        return res.status(400).json({ message: "❌ Produk tidak ditemukan." });
      }

      // 🔎 ambil detail varian jika ada
      let variant = null;
      if (finalVariantId) {
        const { data: v, error: variantError } = await supabase
          .from("product_variants")
          .select("id, variant_name, variant_image_url")
          .eq("id", finalVariantId)
          .single();

        if (!variantError && v) {
          variant = v;
        }
      }

      // 📦 buat snapshot JSON
      const productSnapshot = {
        product_id: product.id,
        product_name: product.product_name,
        product_image_url: product.product_image_url,
        variant_id: variant?.id || null,
        variant_name: variant?.variant_name || null,
        variant_image_url: variant?.variant_image_url || null,
      };

      // ➕ insert rating baru
      const { data: inserted, error: insertError } = await supabase
        .from("ratings")
        .insert([{
          order_id: orderId,
          order_item_id: r.orderItemId,
          product_id: r.productId,
          variant_id: finalVariantId,
          user_id: userInfo.id,
          rating: r.rating,
          review_text: r.reviewText,
          review_images: uploadedUrls,
          product_snapshot: productSnapshot, // <<-- JSONB
        }])
        .select()
        .single();

      if (insertError) {
        console.error("❌ Insert rating error:", insertError);
        return res.status(500).json({ message: "❌ Gagal insert rating.", error: insertError.message });
      }

      resultRatings.push(inserted);
    }

    if (resultRatings.length === 0) {
      return res.status(400).json({ message: "⚠️ Tidak ada rating valid." });
    }

    return res.status(200).json({
      message: "✅ Rating berhasil disimpan.",
      ratings: resultRatings,
    });
  } catch (err) {
    console.error("❌ Server crash:", err);
    return res.status(500).json({ message: "❌ Server error", error: err.message });
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
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;
    if (!userInfo?.id) return res.status(401).json({ message: "❌ Harus login untuk melihat daftar order." });

    const cacheKey = `orders:list:${userInfo.id}`;
    let orders = orderCache.get(cacheKey);
    if (orders) return res.status(200).json({ message: "✅ Daftar order berhasil diambil (cache).", orders });

    // 🔹 Ambil semua order user + seller_address JSON
    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select("id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address")
      .eq("user_id", userInfo.id)
      .order("created_at", { ascending: false });

    if (orderError) return res.status(500).json({ message: "❌ Gagal mengambil data order.", error: orderError });

    const orderIds = ordersData.map(o => o.id);
    if (!orderIds.length) return res.status(200).json({ message: "✅ Tidak ada order.", orders: [] });

    // 🔹 Ambil order_items & detailItems sekaligus
    const [orderItemsRes, detailItemsRes] = await Promise.all([
      supabase.from("order_items").select("order_id, product_id, variant_id, quantity").in("order_id", orderIds),
      supabase.from("order_details_items").select("*").in("order_id", orderIds)
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    // 🔹 Lookup quantity
    const orderItemMap = {};
    orderItems.forEach(oi => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      orderItemMap[key] = oi.quantity ?? 0;
    });

    // 🔹 Total quantity per order
    const qtyByOrder = {};
    orderItems.forEach(item => {
      if (!qtyByOrder[item.order_id]) qtyByOrder[item.order_id] = 0;
      qtyByOrder[item.order_id] += item.quantity ?? 0;
    });

    // 🔹 Map detailItems per order
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

    // 🔹 Gabungkan orders + items + buyer/seller info dari JSON
    orders = ordersData.map(order => {
      let buyerInfo = null;
      let buyerFullAddress = null;
      let sellerInfo = null;
      let sellerFullAddress = null;

      // 🔸 buyer_address
      if (order.buyer_address) {
        try {
          buyerInfo = typeof order.buyer_address === "string"
            ? JSON.parse(order.buyer_address)
            : order.buyer_address;

          const { alamat_lengkap = "", kelurahan = "", kecamatan = "", kota_kabupaten = "", provinsi = "", kode_pos = "" } = buyerInfo;
          buyerFullAddress = [alamat_lengkap, kelurahan, kecamatan, kota_kabupaten, provinsi, kode_pos].filter(Boolean).join(", ");
        } catch (e) {
          console.warn("⚠️ Gagal parse buyer_address:", order.buyer_address);
        }
      }

      // 🔸 seller_address (langsung dari JSON kolom orders)
      if (order.seller_address) {
        try {
          sellerInfo = typeof order.seller_address === "string"
            ? JSON.parse(order.seller_address)
            : order.seller_address;

          const { store_address = "", kelurahan = "", kecamatan = "", kota_kabupaten = "", provinsi = "" } = sellerInfo;
          sellerFullAddress = [store_address, kelurahan, kecamatan, kota_kabupaten, provinsi].filter(Boolean).join(", ");
        } catch (e) {
          console.warn("⚠️ Gagal parse seller_address:", order.seller_address);
        }
      }

      return {
        ...order,
        order_items: itemsByOrder[order.id] || [],
        total_quantity: qtyByOrder[order.id] || 0,
        buyer_info: buyerInfo || null,
        buyer_full_address: buyerFullAddress || null,
        seller_info: sellerInfo || null,
        seller_full_address: sellerFullAddress || null,
      };
    });

    orderCache.set(cacheKey, orders);
    return res.status(200).json({ message: "✅ Daftar order berhasil diambil.", orders });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});


// Route GET /:id - detail order + buyer info
router.get("/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const userInfo = req.cookies?.user_info ? JSON.parse(req.cookies.user_info) : null;

    if (!userInfo?.id)
      return res.status(401).json({ message: "❌ Harus login untuk melihat detail order." });

    const cacheKey = `order:detail:${userInfo.id}:${orderId}`;
    const cached = orderCache.get(cacheKey);
    if (cached)
      return res.status(200).json({
        message: "✅ Detail order berhasil diambil (cache).",
        order: cached,
      });

    // 🔹 Ambil order utama
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(
        "id, created_at, total_price, delivery_fee, status, pickup_method, confirm_deadline, buyer_address, seller_address"
      )
      .eq("id", orderId)
      .eq("user_id", userInfo.id)
      .single();

    if (orderError || !order)
      return res.status(404).json({
        message: "❌ Order tidak ditemukan.",
        error: orderError,
      });

    // 🔹 Ambil order_items & detailItems
    const [orderItemsRes, detailItemsRes] = await Promise.all([
      supabase
        .from("order_items")
        .select("order_id, product_id, variant_id, quantity")
        .eq("order_id", orderId),
      supabase.from("order_details_items").select("*").eq("order_id", orderId),
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    // 🔹 Lookup quantity
    const orderItemMap = {};
    orderItems.forEach((oi) => {
      const key = `${oi.order_id}-${oi.product_id}-${oi.variant_id ?? "null"}`;
      orderItemMap[key] = oi.quantity ?? 0;
    });

    // 🔹 Total quantity
    const totalQuantity = orderItems.reduce(
      (sum, item) => sum + (item.quantity ?? 0),
      0
    );

    // 🔹 Map detailItems
    const items = detailItems.map((item) => {
      const key = `${item.order_id}-${item.product_id}-${item.variant_id ?? "null"}`;
      const quantity = orderItemMap[key] ?? 0;

      return {
        order_item_id: item.order_item_id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image_url: safeParseImageUrl(item.product_image_url),
        quantity,
        price_per_item:
          item.variant_final_price ??
          item.final_price ??
          item.product_price,
        discount_percentage:
          item.variant_discount_percentage ??
          item.discount_percentage ??
          0,
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
      };
    });

    // 🔹 Parse buyer_address
    let buyerInfo = null,
      buyerFullAddress = null;
    if (order.buyer_address) {
      try {
        buyerInfo =
          typeof order.buyer_address === "string"
            ? JSON.parse(order.buyer_address)
            : order.buyer_address;

        const {
          alamat_lengkap = "",
          kelurahan = "",
          kecamatan = "",
          kota_kabupaten = "",
          provinsi = "",
          kode_pos = "",
        } = buyerInfo;
        buyerFullAddress = [
          alamat_lengkap,
          kelurahan,
          kecamatan,
          kota_kabupaten,
          provinsi,
          kode_pos,
        ]
          .filter(Boolean)
          .join(", ");
      } catch (e) {
        console.warn("⚠️ Gagal parse buyer_address:", order.buyer_address);
      }
    }

    // 🔹 Parse seller_address
    let sellerInfo = null,
      sellerFullAddress = null;
    if (order.seller_address) {
      try {
        sellerInfo =
          typeof order.seller_address === "string"
            ? JSON.parse(order.seller_address)
            : order.seller_address;

        const {
          store_address = "",
          kelurahan = "",
          kecamatan = "",
          kota_kabupaten = "",
          provinsi = "",
        } = sellerInfo;
        sellerFullAddress = [
          store_address,
          kelurahan,
          kecamatan,
          kota_kabupaten,
          provinsi,
        ]
          .filter(Boolean)
          .join(", ");
      } catch (e) {
        console.warn("⚠️ Gagal parse seller_address:", order.seller_address);
      }
    }

    // 🔹 Final result
    const orderResult = {
      ...order,
      order_items: items,
      total_quantity: totalQuantity,
      buyer_info: buyerInfo,
      buyer_full_address: buyerFullAddress,
      seller_info: sellerInfo,
      seller_full_address: sellerFullAddress,
    };

    orderCache.set(cacheKey, orderResult);
    return res
      .status(200)
      .json({ message: "✅ Detail order berhasil diambil.", order: orderResult });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res
      .status(500)
      .json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});




module.exports = router;
