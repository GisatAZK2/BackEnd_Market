const supabase = require("../config/supabase");
const { DateTime } = require("luxon");

function applyDiscount(price, discountPercentage) {
  return Math.round(price * (1 - discountPercentage / 100));
}

/**
 * Ambil diskon aktif + detail event / flash sale / diskon toko spesifik item
 */
async function getActiveDiscountForProduct(
  productId,
  storeId,
  variantId = null,
) {
  const now = DateTime.utc();
  let discountPercentage = 0;
  const sources = [];
  const details = { events: [], flash_sales: [], store_discounts: [] };

  // === EVENT PRODUCT ===
  const { data: eventProducts = [], error: epErr } = await supabase
    .from("event_products")
    .select("event_discount,event_id,event_stock,variant_id")
    .eq("product_id", productId);

  if (epErr) console.error("EventProducts error:", epErr);

  for (const ep of eventProducts) {
    const { data: event, error: eErr } = await supabase
      .from("events")
      .select("id,title,start_time,end_time")
      .eq("id", ep.event_id)
      .single();

    if (eErr) console.error("Event error:", eErr);

    if (event) {
      const start = DateTime.fromISO(event.start_time).toUTC();
      const end = DateTime.fromISO(event.end_time).toUTC();
      if (start <= now && end >= now) {
        discountPercentage = Math.max(discountPercentage, ep.event_discount);
        if (!sources.includes("event")) sources.push("event");
        details.events.push({ ...event, discount: ep.event_discount });
      }
    }
  }

  // === FLASH SALE ===
  const { data: flashSales = [], error: fsErr } = await supabase
    .from("flash_sales")
    .select("id,discount_percentage,start_time,end_time,flash_stock")
    .eq("product_id", productId);

  if (fsErr) console.error("FlashSales error:", fsErr);

  for (const fs of flashSales) {
    const start = DateTime.fromISO(fs.start_time).toUTC();
    const end = DateTime.fromISO(fs.end_time).toUTC();
    if (start <= now && end >= now) {
      discountPercentage = Math.max(discountPercentage, fs.discount_percentage);
      if (!sources.includes("flash_sale")) sources.push("flash_sale");
      details.flash_sales.push(fs);
    }
  }

  // === STORE DISCOUNT (spesifik item) ===
  const { data: storeDiscountItems = [], error: sdiErr } = await supabase
    .from("store_discount_items")
    .select(
      `
        product_id,
        variant_id,
        discount_percentage,
        store_discounts!inner(id,name,start_time,end_time)
      `,
    )
    .eq("product_id", productId);

  if (sdiErr) console.error("StoreDiscountItems error:", sdiErr);
  console.log("DEBUG storeDiscountItems:", storeDiscountItems);

  const matched =
    (variantId && storeDiscountItems.find((i) => i.variant_id === variantId)) ||
    storeDiscountItems.find(
      (i) => i.variant_id === null || i.variant_id === undefined,
    );

  if (matched?.store_discounts) {
    const sd = matched.store_discounts;
    const start = DateTime.fromISO(sd.start_time).toUTC();
    const end = DateTime.fromISO(sd.end_time).toUTC();
    if (start <= now && end >= now) {
      discountPercentage = Math.max(
        discountPercentage,
        matched.discount_percentage,
      );
      if (!sources.includes("store_discount")) sources.push("store_discount");
      details.store_discounts.push({
        ...sd,
        discount_percentage: matched.discount_percentage,
      });
    }
  }

  return { discountPercentage, sources, details };
}

/**
 * Attach variants, stok promo, & diskon ke produk (event, flash sale, store item discount)
 */
async function attachVariantsStockDiscount(products) {
  if (!products.length) return [];

  const productIds = products.map((p) => p.id);
  const now = DateTime.utc();

  const { data: eventProducts = [], error: epErr } = await supabase
    .from("event_products")
    .select("product_id,variant_id,event_discount,event_stock,event_id")
    .in("product_id", productIds);
  if (epErr) console.error("EventProducts error:", epErr);

  const { data: events = [], error: eErr } = await supabase
    .from("events")
    .select("id,title,start_time,end_time")
    .lte("start_time", now.toISO())
    .gte("end_time", now.toISO());
  if (eErr) console.error("Events error:", eErr);

  const { data: flashSales = [], error: fsErr } = await supabase
    .from("flash_sales")
    .select("*")
    .in("product_id", productIds)
    .lte("start_time", now.toISO())
    .gte("end_time", now.toISO());
  if (fsErr) console.error("FlashSales error:", fsErr);

  const { data: variants = [], error: vErr } = await supabase
    .from("product_variants")
    .select("*")
    .in("product_id", productIds);
  if (vErr) console.error("Variants error:", vErr);

  const { data: storeDiscountItems = [], error: sdiErr } = await supabase
    .from("store_discount_items")
    .select(
      `
        product_id,
        variant_id,
        discount_percentage,
        store_discounts!inner(id,name,start_time,end_time)
      `,
    )
    .in("product_id", productIds);
  if (sdiErr) console.error("StoreDiscountItems error:", sdiErr);
  console.log("DEBUG storeDiscountItems (bulk):", storeDiscountItems);

  return products.map((product) => {
    const eventList = eventProducts.filter(
      (ep) => ep.product_id === product.id,
    );
    const activeEventList = eventList
      .map((ep) => ({
        ...ep,
        eventData: events.find((e) => e.id === ep.event_id),
      }))
      .filter((ep) => ep.eventData);
    const hasEventForThisProduct = activeEventList.length > 0;

    const flashSaleList = flashSales.filter(
      (fs) => fs.product_id === product.id,
    );
    const flashSaleDiscount = flashSaleList.length
      ? Math.max(...flashSaleList.map((fs) => fs.discount_percentage))
      : 0;

    // Diskon toko spesifik produk
    const storeDiscountForProduct = storeDiscountItems.find(
      (i) =>
        i.product_id === product.id &&
        (i.variant_id === null || i.variant_id === undefined),
    );
    const storeDiscountProductPercentage =
      storeDiscountForProduct &&
      // Hilangkan pengecekan start_time supaya preview diskon aktif
      DateTime.fromISO(
        storeDiscountForProduct.store_discounts.end_time,
      ).toUTC() >= now
        ? storeDiscountForProduct.discount_percentage
        : 0;

    const eventStock = hasEventForThisProduct
      ? Math.max(...activeEventList.map((ep) => ep.event_stock))
      : null;
    const flashSaleStock = flashSaleList.length
      ? flashSaleList[0].flash_stock
      : null;
    const finalStock = flashSaleStock ?? eventStock ?? product.stock ?? 0;

    const productVariants = variants.filter((v) => v.product_id === product.id);

    // === Produk tanpa varian ===
    if (productVariants.length === 0) {
      let discountPercentage = 0;
      let discountSource = null;

      if (hasEventForThisProduct) {
        discountPercentage = Math.max(
          ...activeEventList.map((ep) => ep.event_discount),
        );
        discountSource =
          activeEventList.find((ep) => ep.event_discount === discountPercentage)
            ?.eventData?.title || "event";
      } else if (flashSaleDiscount > storeDiscountProductPercentage) {
        discountPercentage = flashSaleDiscount;
        discountSource = "flash_sale";
      } else if (storeDiscountProductPercentage > 0) {
        discountPercentage = storeDiscountProductPercentage;
        discountSource = "store_discount";
      }

      return {
        ...product,
        variants: [],
        finalStock,
        finalPrice: applyDiscount(product.product_price, discountPercentage),
        discountPercentage,
        discountSource,
      };
    }

    // === Produk dengan varian ===
    const variantsWithDiscount = productVariants.map((v) => {
      const eventForThisVariant = activeEventList.find(
        (ep) =>
          ep.variant_id === v.id ||
          (!ep.variant_id && ep.product_id === v.product_id),
      );

      const storeDiscountForVariant = storeDiscountItems.find(
        (i) => i.variant_id === v.id,
      );
      const storeDiscountVariantPercentage =
        storeDiscountForVariant &&
        DateTime.fromISO(
          storeDiscountForVariant.store_discounts.start_time,
        ).toUTC() <= now &&
        DateTime.fromISO(
          storeDiscountForVariant.store_discounts.end_time,
        ).toUTC() >= now
          ? storeDiscountForVariant.discount_percentage
          : storeDiscountProductPercentage;

      let discountPercentage = 0;
      let discountSource = null;

      if (eventForThisVariant) {
        discountPercentage = eventForThisVariant.event_discount;
        discountSource = eventForThisVariant.eventData?.title || "event";
      } else if (!hasEventForThisProduct) {
        if (flashSaleDiscount > storeDiscountVariantPercentage) {
          discountPercentage = flashSaleDiscount;
          discountSource = "flash_sale";
        } else if (storeDiscountVariantPercentage > 0) {
          discountPercentage = storeDiscountVariantPercentage;
          discountSource = "store_discount";
        }
      }

      return {
        ...v,
        original_price: v.variant_price,
        final_price: applyDiscount(v.variant_price, discountPercentage),
        applied_discount: discountPercentage,
        discount_source: discountSource,
      };
    });

    const finalPrice = Math.min(
      ...variantsWithDiscount.map((v) => v.final_price),
    );
    const productDiscountSource = hasEventForThisProduct
      ? activeEventList[0].eventData?.title || "event"
      : flashSaleDiscount > storeDiscountProductPercentage
        ? "flash_sale"
        : storeDiscountProductPercentage > 0
          ? "store_discount"
          : null;

    return {
      ...product,
      variants: variantsWithDiscount,
      finalStock,
      finalPrice,
      discountPercentage: hasEventForThisProduct
        ? 0
        : Math.max(storeDiscountProductPercentage, flashSaleDiscount),
      discountSource: productDiscountSource,
    };
  });
}

module.exports = {
  applyDiscount,
  getActiveDiscountForProduct,
  attachVariantsStockDiscount,
};
