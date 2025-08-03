const express = require("express");
const supabase = require("../config/supabase");
const {
  getActiveDiscountForProduct,
  applyDiscount,
} = require("../utils/applyDiscountAndVariants");
const router = express.Router();

// === Cek cookie user_info langsung di setiap rute ===
function getUserFromCookie(req) {
  if (!req.cookies.user_info) return null;
  try {
    return typeof req.cookies.user_info === "string"
      ? JSON.parse(req.cookies.user_info)
      : req.cookies.user_info;
  } catch (e) {
    return null;
  }
}

// === Get cart with harga promo ===
router.get("/cart", async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user || !user.id) {
    return res
      .status(403)
      .json({ message: "❌ Harus login (cookie tidak valid)" });
  }

  try {
    const { data: cart } = await supabase
      .from("carts")
      .select("items")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!cart || !cart.items)
      return res.json({ message: "✅ Cart kosong", cart: [] });

    const productIds = cart.items.map((c) => c.productId);
    const { data: products } = await supabase
      .from("products")
      .select("*")
      .in("id", productIds);

    const detailedCart = await Promise.all(
      cart.items.map(async (item) => {
        const product = products.find((p) => p.id === item.productId);
        if (!product) return null;

        // Ambil varian jika ada
        let variant = null;
        if (item.variantId) {
          const { data: v } = await supabase
            .from("product_variants")
            .select("*")
            .eq("id", item.variantId)
            .single();
          variant = v;
        }

        const { discountPercentage } = await getActiveDiscountForProduct(
          product.id,
          product.store_id,
          variant?.id || null,
        );

        const basePrice = variant
          ? variant.variant_price
          : product.product_price;
        const finalPrice =
          discountPercentage > 0
            ? applyDiscount(basePrice, discountPercentage)
            : basePrice;

        return {
          productId: product.id,
          name: product.product_name,
          variantId: variant?.id || null,
          variantName: variant?.variant_name || null,
          qty: item.qty,
          basePrice,
          finalPrice,
          discountApplied: discountPercentage > 0 ? discountPercentage : null,
          isDiscounted: discountPercentage > 0,
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

// === Add to cart ===
router.post("/cart/add", async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user || !user.id) {
    return res
      .status(403)
      .json({ message: "❌ Harus login (cookie tidak valid)" });
  }

  const { productId, variantId = null, qty = 1 } = req.body;
  if (!productId) {
    return res.status(400).json({ message: "❌ productId wajib diisi" });
  }

  try {
    const { data: cart } = await supabase
      .from("carts")
      .select("items")
      .eq("user_id", user.id)
      .maybeSingle();

    let newItems = [];
    if (cart) {
      const existingItemIndex = cart.items.findIndex(
        (item) => item.productId === productId && item.variantId === variantId,
      );

      if (existingItemIndex !== -1) {
        cart.items[existingItemIndex].qty += qty;
        newItems = cart.items;
      } else {
        newItems = [...cart.items, { productId, variantId, qty }];
      }

      await supabase
        .from("carts")
        .update({ items: newItems })
        .eq("user_id", user.id);
    } else {
      newItems = [{ productId, variantId, qty }];
      await supabase
        .from("carts")
        .insert([{ user_id: user.id, items: newItems }]);
    }

    return res.json({
      message: "✅ Produk ditambahkan ke cart",
      items: newItems,
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "❌ Error server", error: err.message });
  }
});

module.exports = router;
