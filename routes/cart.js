const express = require("express");
const supabase = require("../config/supabase");
const {
  attachVariantsStockDiscountWithRealDiscount,
  applyDiscount,
} = require("../utils/applyDiscountAndVariants");
const router = express.Router();

// === Ambil user dari cookie ===
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

// === GET CART ===
router.get("/cart", async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user?.id) {
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

        let variant = null;
        if (item.variantId) {
          const { data: v } = await supabase
            .from("product_variants")
            .select("*")
            .eq("id", item.variantId)
            .single();
          variant = v;
        }

        const [productWithDiscount] =
          await attachVariantsStockDiscountWithRealDiscount([product]);
        const discountPercentage = productWithDiscount.discountPercentage;

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

// === ADD TO CART ===
router.post("/cart/add", async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user?.id) {
    return res
      .status(403)
      .json({ message: "❌ Harus login (cookie tidak valid)" });
  }

  const { productId, variantId = null, qty = 1 } = req.body;
  if (!productId)
    return res.status(400).json({ message: "❌ productId wajib diisi" });

  try {
    const { data: cart } = await supabase
      .from("carts")
      .select("items")
      .eq("user_id", user.id)
      .maybeSingle();

    let newItems = [];
    if (cart) {
      const existingItemIndex = cart.items.findIndex(
        (item) =>
          item.productId === productId &&
          (item.variantId == variantId ||
            (item.variantId == null && variantId == null)),
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

// === UPDATE CART ===
router.put("/cart/update", async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user?.id) {
    return res
      .status(403)
      .json({ message: "❌ Harus login (cookie tidak valid)" });
  }

  const { productId, variantId = null, qty } = req.body;
  if (!productId || qty == null)
    return res.status(400).json({ message: "❌ productId & qty wajib diisi" });

  try {
    const { data: cart } = await supabase
      .from("carts")
      .select("items")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!cart || !cart.items.length)
      return res.status(404).json({ message: "❌ Cart kosong" });

    const itemIndex = cart.items.findIndex(
      (item) =>
        item.productId === productId &&
        (item.variantId == variantId ||
          (item.variantId == null && variantId == null)),
    );

    if (itemIndex === -1)
      return res.status(404).json({ message: "❌ Produk tidak ada di cart" });

    if (qty <= 0) cart.items.splice(itemIndex, 1);
    else cart.items[itemIndex].qty = qty;

    await supabase
      .from("carts")
      .update({ items: cart.items })
      .eq("user_id", user.id);

    return res.json({
      message: "✅ Cart berhasil diupdate",
      items: cart.items,
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "❌ Error server", error: err.message });
  }
});

// === REMOVE ITEM FROM CART ===
router.delete("/cart/remove/:productId", async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user?.id) {
    return res
      .status(403)
      .json({ message: "❌ Harus login (cookie tidak valid)" });
  }

  const { productId } = req.params;
  const { variantId } = req.query; // bisa undefined, "null", atau uuid

  try {
    const { data: cart } = await supabase
      .from("carts")
      .select("items")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!cart || !cart.items.length)
      return res.status(404).json({ message: "❌ Cart kosong" });

    const productHasVariant = cart.items.some(
      (item) => item.productId === productId && item.variantId !== null,
    );

    const newItems = cart.items.filter((item) => {
      const sameProduct = item.productId === productId;
      const sameVariant =
        variantId === undefined || variantId === null || variantId === "null"
          ? item.variantId === null
          : item.variantId == variantId;

      if (!productHasVariant) return item.productId !== productId; // produk single
      if (variantId) return !(sameProduct && sameVariant); // hapus variant tertentu
      return item.productId !== productId; // hapus semua variant
    });

    await supabase
      .from("carts")
      .update({ items: newItems })
      .eq("user_id", user.id);

    return res.json({ message: "✅ Item berhasil dihapus", items: newItems });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "❌ Error server", error: err.message });
  }
});

module.exports = router;
