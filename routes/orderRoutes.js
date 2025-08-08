// router/checkout.js
const express = require("express");
const supabase = require("../config/supabase");
const sendOrderNotification = require("../utils/email");
const {
  attachVariantsStockDiscountWithRealDiscount,
  applyDiscount,
} = require("../utils/applyDiscountAndVariants");
const detectSpam = require("../middleware/detectSpam");
const verifyCaptcha = require("../middleware/verifyCaptcha");

const router = express.Router();

router.post("/cart/checkout", detectSpam, verifyCaptcha, async (req, res) => {
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

    const sellerIds = new Set();
    for (const item of itemsToProcess) {
      const { data: product } = await supabase
        .from("products")
        .select("seller_id")
        .eq("id", item.productId)
        .single();
      if (product) sellerIds.add(product.seller_id);
    }

    const isSameSeller = sellerIds.size === 1;
    const createdOrders = [];

    const processOrder = async (seller_id, sellerItems) => {
      const productDetails = [];
      let total_price = 0;
      let delivery_fee = 0;

      for (const item of sellerItems) {
        const { productId, variantId, qty } = item;
        const { data: product } = await supabase
          .from("products")
          .select("*")
          .eq("id", productId)
          .single();

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
          await attachVariantsStockDiscountWithRealDiscount([
            { id: productId },
          ]);

        const discountPercentage = variantId
          ? productWithDiscount.variants.find((v) => v.id === variantId)
              ?.applied_discount || 0
          : productWithDiscount.discountPercentage || 0;

        const basePrice = variant
          ? variant.variant_price
          : product.product_price;

        const finalUnitPrice = applyDiscount(basePrice, discountPercentage);
        const subtotal = finalUnitPrice * qty;
        total_price += subtotal;

        productDetails.push({
          product_name: product.product_name,
          variant_name: variant?.variant_name || null,
          quantity: qty,
          price: subtotal,
          image_url:
            variant?.variant_image_url ||
            (Array.isArray(product.product_image_url)
              ? product.product_image_url[0]
              : product.product_image_url),
        });
      }

      if (pickupMethod === "diantar") {
        const { data: seller } = await supabase
          .from("sellers")
          .select("is_delivery_available, delivery_fee")
          .eq("id", seller_id)
          .single();

        if (!seller?.is_delivery_available || !seller.delivery_fee) return;

        delivery_fee = seller.delivery_fee;
        total_price += delivery_fee;
      }

      const pickupDeadline = new Date(Date.now() + 6 * 60 * 60 * 1000);
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .insert([
          {
            user_id: user.id,
            seller_id,
            product_id: null,
            variant_id: null,
            quantity: sellerItems.reduce((acc, cur) => acc + cur.qty, 0),
            total_price,
            delivery_fee,
            pickup_method: pickupMethod,
            status: "pending",
            pickup_deadline: pickupDeadline.toISOString(),
            order_details: productDetails,
          },
        ])
        .select()
        .single();

      if (!orderErr) {
        const { data: sellerData } = await supabase
          .from("sellers")
          .select("email")
          .eq("id", seller_id)
          .single();

        const { data: buyerData } = await supabase
          .from("users")
          .select("email, username")
          .eq("id", user.id)
          .single();

        await sendOrderNotification({
          isGrouped: true,
          productDetails,
          total_price,
          delivery_fee,
          buyer_email: buyerData.email,
          seller_email: sellerData?.email,
          buyer_username: buyerData.username,
        });

        createdOrders.push(order);
      }
    };

    if (isSameSeller) {
      const seller_id = Array.from(sellerIds)[0];
      await processOrder(seller_id, itemsToProcess);
    } else {
      const itemsBySeller = {};

      for (const item of itemsToProcess) {
        const { data: product } = await supabase
          .from("products")
          .select("seller_id")
          .eq("id", item.productId)
          .single();

        if (!itemsBySeller[product.seller_id]) {
          itemsBySeller[product.seller_id] = [];
        }
        itemsBySeller[product.seller_id].push(item);
      }

      for (const seller_id in itemsBySeller) {
        await processOrder(seller_id, itemsBySeller[seller_id]);
      }
    }

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
