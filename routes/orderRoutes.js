const express = require("express");
const supabase = require("../config/supabase");
const sendOrderNotification = require("../utils/email");
const {
  attachVariantsStockDiscountWithRealDiscount,
  applyDiscount,
} = require("../utils/applyDiscountAndVariants");
const verifyCaptcha = require("../middleware/verifyCaptcha");

const router = express.Router();

router.post("/cart/checkout", async (req, res) => {
  const user = req.cookies?.user_info
    ? JSON.parse(req.cookies.user_info)
    : null;
  if (!user?.id) return res.status(403).json({ message: "❌ Harus login" });

  const { itemsToCheckout = [], pickupMethod = "diambil" } = req.body;

  if (!["diambil", "diantar"].includes(pickupMethod)) {
    return res
      .status(400)
      .json({ message: "❌ pickupMethod harus 'diambil' atau 'diantar'" });
  }

  try {
    const { data: cartData } = await supabase
      .from("carts")
      .select("items")
      .eq("user_id", user.id)
      .maybeSingle();

    const cartItems = cartData?.items || [];
    if (!cartItems.length) {
      return res.status(400).json({ message: "❌ Cart kosong" });
    }

    const itemsToProcess = itemsToCheckout.length
      ? cartItems.filter((item) =>
          itemsToCheckout.some(
            (i) =>
              i.productId === item.productId && i.variantId === item.variantId,
          ),
        )
      : cartItems;

    if (!itemsToProcess.length) {
      return res
        .status(400)
        .json({ message: "❌ Tidak ada item yang dipilih untuk checkout" });
    }

    const createdOrders = [];

    for (const item of itemsToProcess) {
      const { productId, variantId, qty } = item;

      const { data: product } = await supabase
        .from("products")
        .select("*")
        .eq("id", productId)
        .single();
      if (!product) continue;

      // Ambil data varian jika ada
      let variant = null;
      if (variantId) {
        const { data: v } = await supabase
          .from("product_variants")
          .select("*")
          .eq("id", variantId)
          .single();
        variant = v;
      }

      const [productWithDiscount] =
        await attachVariantsStockDiscountWithRealDiscount([{ id: productId }]);

      const discountPercentage = variantId
        ? productWithDiscount.variants.find((v) => v.id === variantId)
            ?.applied_discount || 0
        : productWithDiscount.discountPercentage || 0;

      const basePrice = variant ? variant.variant_price : product.product_price;
      const finalUnitPrice = applyDiscount(basePrice, discountPercentage);
      let total_price = finalUnitPrice * qty;

      // === Cek biaya antar ===
      let delivery_fee = 0;
      if (pickupMethod === "diantar") {
        const { data: seller } = await supabase
          .from("sellers")
          .select("is_delivery_available, delivery_fee")
          .eq("id", product.seller_id)
          .single();

        if (!seller?.is_delivery_available) {
          return res.status(400).json({
            message: `❌ Penjual ${product.seller_id} tidak melayani pengantaran`,
          });
        }

        if (!seller.delivery_fee || isNaN(seller.delivery_fee)) {
          return res.status(400).json({
            message: `❌ Penjual belum atur biaya antar yang valid`,
          });
        }

        delivery_fee = seller.delivery_fee;
        total_price += delivery_fee;
      }

      const pickupDeadline = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6 jam dari sekarang

      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .insert([
          {
            user_id: user.id,
            product_id: product.id,
            seller_id: product.seller_id,
            variant_id: variant?.id || null,
            quantity: qty,
            total_price,
            delivery_fee,
            pickup_method: pickupMethod,
            status: "pending",
            pickup_deadline: pickupDeadline.toISOString(),
          },
        ])
        .select()
        .single();

      if (orderErr) {
        console.warn(
          `❌ Gagal order produk ${product.id}: ${orderErr.message}`,
        );
        continue;
      }

      // Ambil info email seller & buyer
      const { data: sellerData } = await supabase
        .from("sellers")
        .select("email")
        .eq("id", product.seller_id)
        .single();

      const { data: buyerData } = await supabase
        .from("users")
        .select("email, username")
        .eq("id", user.id)
        .single();

      const imageUrl =
        variant?.variant_image_url ||
        (Array.isArray(product.product_image_url)
          ? product.product_image_url[0]
          : product.product_image_url) ||
        "https://yourdomain.com/default-image.jpg";

      try {
        await sendOrderNotification({
          product_name: product.product_name,
          variant_name: variant?.variant_name || null,
          quantity: qty,
          total_price,
          delivery_fee,
          product_image_url: imageUrl,
          buyer_email: buyerData.email,
          seller_email: sellerData?.email,
          buyer_username: buyerData.username,
        });
      } catch (emailErr) {
        console.warn(
          `📭 Gagal kirim email order produk ${product.id}: ${emailErr.message}`,
        );
      }

      createdOrders.push(order);
    }

    // Hapus item yang sudah di-checkout dari cart
    const updatedCart = cartItems.filter(
      (cartItem) =>
        !itemsToProcess.some(
          (i) =>
            i.productId === cartItem.productId &&
            i.variantId === cartItem.variantId,
        ),
    );

    await supabase
      .from("carts")
      .update({ items: updatedCart })
      .eq("user_id", user.id);

    return res.status(201).json({
      message: `✅ Checkout berhasil (${createdOrders.length} pesanan dibuat)`,
      orders: createdOrders,
    });
  } catch (err) {
    console.error("❌ Checkout error:", err.message);
    return res
      .status(500)
      .json({ message: "❌ Server error", error: err.message });
  }
});

module.exports = router;
