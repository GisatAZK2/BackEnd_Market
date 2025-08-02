const express = require("express");
const supabase = require("../config/supabase");
const router = express.Router();

// Helper hitung harga promo
async function getEffectivePrice(productId, storeId, basePrice) {
  const now = new Date().toISOString();

  // 1️⃣ Flash Sale
  const { data: flash } = await supabase
    .from("flash_sales")
    .select("*")
    .eq("product_id", productId)
    .lte("start_time", now)
    .gte("end_time", now)
    .maybeSingle();

  if (flash) {
    return {
      price: basePrice * (1 - flash.discount_percentage / 100),
      promo: "flash_sale",
      stock_source: "flash",
      available_stock: flash.flash_stock,
    };
  }

  // 2️⃣ Event Global
  const { data: event } = await supabase
    .from("events")
    .select("*")
    .lte("start_time", now)
    .gte("end_time", now)
    .maybeSingle();

  if (event) {
    return {
      price: basePrice * 0.9, // misal fix 10%, bisa tambah kolom discount_percentage di events
      promo: "event",
      stock_source: "product",
      available_stock: null,
    };
  }

  // 3️⃣ Diskon Toko
  const { data: discount } = await supabase
    .from("store_discounts")
    .select("*")
    .eq("store_id", storeId)
    .lte("start_time", now)
    .gte("end_time", now)
    .maybeSingle();

  if (discount) {
    return {
      price: basePrice * (1 - discount.percentage / 100),
      promo: "store_discount",
      stock_source: "product",
      available_stock: null,
    };
  }

  // 4️⃣ Default
  return {
    price: basePrice,
    promo: null,
    stock_source: "product",
    available_stock: null,
  };
}

// Get cart with harga promo
router.get("/cart", async (req, res) => {
  const userId = req.query.user_id; // ambil dari query / token
  if (!userId) return res.status(403).json({ message: "❌ Harus login" });

  try {
    const { data: cart } = await supabase
      .from("carts")
      .select("items")
      .eq("user_id", userId)
      .maybeSingle();

    if (!cart || !cart.items)
      return res.json({ message: "✅ Cart kosong", cart: [] });

    // Ambil produk dari cart
    const productIds = cart.items.map((c) => c.productId);
    const { data: products } = await supabase
      .from("products")
      .select("*")
      .in("id", productIds);

    // Map dengan harga promo
    const detailedCart = await Promise.all(
      cart.items.map(async (item) => {
        const product = products.find((p) => p.id === item.productId);
        if (!product) return null;

        const priceInfo = await getEffectivePrice(
          product.id,
          product.store_id,
          product.product_price,
        );

        return {
          productId: product.id,
          name: product.product_name,
          qty: item.qty,
          basePrice: product.product_price,
          finalPrice: priceInfo.price,
          promo: priceInfo.promo,
        };
      }),
    );

    return res.json({
      message: "✅ Cart ditemukan",
      cart: detailedCart.filter(Boolean),
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "❌ Error server", error: err.message });
  }
});

module.exports = router;
