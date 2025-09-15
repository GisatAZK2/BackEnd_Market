// routes/products.js
const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const { DateTime } = require("luxon");

function applyDiscount(price, discountPercentage) {
  return Math.round(price * (1 - discountPercentage / 100));
}

async function attachVariantsStockDiscountWithRealDiscount(products) {
  if (!products.length) return [];

  const now = DateTime.utc();
  const productIds = products.map((p) => p.id);

  // Ambil semua data varian + diskon
  const [
    { data: variants = [] },
    { data: eventProducts = [] },
    { data: flashSaleProducts = [] },
    { data: storeDiscountItems = [] },
  ] = await Promise.all([
    supabase.from("product_variants").select("*").in("product_id", productIds),
    supabase
      .from("event_products")
      .select("event_discount,event_id,variant_id,product_id,event_stock")
      .in("product_id", productIds),
    supabase
      .from("flash_sale_products")
      .select(
        "flash_sale_id,discount_percentage,variant_id,product_id,flash_stock"
      )
      .in("product_id", productIds),
    supabase
      .from("store_discount_items")
      .select(
        `product_id,variant_id,discount_percentage,stock,store_discounts!inner(id,name,start_time,end_time)`
      )
      .in("product_id", productIds),
  ]);

  // Ambil detail event & flash sale
  const eventIds = [...new Set(eventProducts.map((e) => e.event_id))];
  const flashSaleIds = [...new Set(flashSaleProducts.map((f) => f.flash_sale_id))];

  const [{ data: events = [] }, { data: flashSales = [] }] = await Promise.all([
    eventIds.length
      ? supabase
          .from("events")
          .select("id,title,start_time,end_time")
          .in("id", eventIds)
      : Promise.resolve({ data: [] }),
    flashSaleIds.length
      ? supabase
          .from("flash_sales")
          .select("id,start_time,end_time,status")
          .in("id", flashSaleIds)
      : Promise.resolve({ data: [] }),
  ]);

  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]));
  const flashSaleMap = Object.fromEntries(flashSales.map((f) => [f.id, f]));

  // ====== Kalkulasi Diskon dengan Prioritas ======
  const calcDiscount = (productId, variantId = null) => {
    const activeDiscounts = {
      flash_sale: null,
      event: null,
      store_discount: null,
    };

    // === EVENT ===
    eventProducts
      .filter(
        (ep) =>
          ep.product_id === productId &&
          (!variantId || ep.variant_id === variantId)
      )
      .forEach((ep) => {
        const event = eventMap[ep.event_id];
        if (!event) return;
        if (ep.event_stock !== null && ep.event_stock <= 0) return; // stok habis

        const start = DateTime.fromISO(event.start_time).toUTC();
        const end = DateTime.fromISO(event.end_time).toUTC();
        if (start <= now && end >= now) {
          activeDiscounts.event = {
            discount: ep.event_discount,
            source: "event",
            details: { ...event, discount: ep.event_discount },
          };
        }
      });

    // === FLASH SALE ===
    flashSaleProducts
      .filter(
        (fp) =>
          fp.product_id === productId &&
          (!variantId || fp.variant_id === variantId)
      )
      .forEach((fsp) => {
        const flashSale = flashSaleMap[fsp.flash_sale_id];
        if (!flashSale) return;
        if (flashSale.status === "disabled") return;
        if (fsp.flash_stock !== null && fsp.flash_stock <= 0) return; // stok habis

        const start = DateTime.fromISO(flashSale.start_time).toUTC();
        const end = DateTime.fromISO(flashSale.end_time).toUTC();

        if (flashSale.status === "active" && start <= now && end >= now) {
          activeDiscounts.flash_sale = {
            discount: fsp.discount_percentage,
            source: "flash_sale",
            details: { ...flashSale, discount: fsp.discount_percentage },
          };
        }
      });

    // === STORE DISCOUNT ===
    const matched =
      (variantId &&
        storeDiscountItems.find(
          (i) => i.product_id === productId && i.variant_id === variantId
        )) ||
      storeDiscountItems.find(
        (i) => i.product_id === productId && i.variant_id === null
      );
    if (matched?.store_discounts) {
      if (!(matched.stock !== null && matched.stock <= 0)) {
        const sd = matched.store_discounts;
        const start = DateTime.fromISO(sd.start_time).toUTC();
        const end = DateTime.fromISO(sd.end_time).toUTC();
        if (start <= now && end >= now) {
          activeDiscounts.store_discount = {
            discount: matched.discount_percentage,
            source: "store_discount",
            details: { ...sd, discount: matched.discount_percentage },
          };
        }
      }
    }

    // === PRIORITAS DISKON ===
    let applied = null;
    if (activeDiscounts.flash_sale) {
      applied = activeDiscounts.flash_sale;
    } else if (activeDiscounts.event) {
      applied = activeDiscounts.event;
    } else if (activeDiscounts.store_discount) {
      applied = activeDiscounts.store_discount;
    }

    return {
      discountPercentage: applied ? applied.discount : 0,
      sources: applied ? [applied.source] : [],
      details: applied ? applied.details : {},
    };
  };

  // ====== Proses Produk ======
  return products.map((product) => {
    const productVariants = variants.filter((v) => v.product_id === product.id);

    // === Produk tanpa varian ===
    if (productVariants.length === 0) {
      const discount = calcDiscount(product.id);
      return {
        ...product,
        variants: [],
        finalStock: product.stock,
        finalPrice: applyDiscount(
          product.product_price,
          discount.discountPercentage
        ),
        discountPercentage: discount.discountPercentage,
        discountSource: discount.sources,
        discountDetails: discount.details,
      };
    }

    // === Produk dengan varian ===
    const variantsWithDiscount = productVariants.map((v) => {
      const discount = calcDiscount(product.id, v.id);
      const finalPrice = applyDiscount(
        v.variant_price,
        discount.discountPercentage
      );

      return {
        id: v.id,
        variant_name: v.variant_name,
        variant_price: v.variant_price,
        variant_image_url: v.variant_image_url,
        variant_stock: v.variant_stock,
        original_price: v.variant_price,
        final_price: finalPrice,
        applied_discount: discount.discountPercentage,
        discount_source: discount.sources,
        discount_details: discount.details,
      };
    });

    return {
      ...product,
      variants: variantsWithDiscount,
    };
  });
}

module.exports = {
  applyDiscount,
  attachVariantsStockDiscountWithRealDiscount,
};
