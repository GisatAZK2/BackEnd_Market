const supabase = require("../config/supabase");
const { DateTime } = require("luxon");

function applyDiscount(price, discountPercentage) {
  return Math.round(price * (1 - discountPercentage / 100));
}

async function attachVariantsStockDiscountWithRealDiscount(products) {
  if (!products.length) return [];

  const now = DateTime.utc();
  const productIds = products.map((p) => p.id);

  // Ambil semua varian sekaligus
  const [
    { data: variants = [] },
    { data: eventProducts = [] },
    { data: flashSaleProducts = [] },
    { data: storeDiscountItems = [] },
  ] = await Promise.all([
    supabase.from("product_variants").select("*").in("product_id", productIds),
    supabase
      .from("event_products")
      .select("event_discount,event_id,variant_id,product_id")
      .in("product_id", productIds),
    supabase
      .from("flash_sale_products")
      .select("flash_sale_id,discount_percentage,variant_id,product_id")
      .in("product_id", productIds),
    supabase
      .from("store_discount_items")
      .select(
        `product_id,variant_id,discount_percentage,store_discounts!inner(id,name,start_time,end_time)`,
      )
      .in("product_id", productIds),
  ]);

  // Ambil event dan flash sale detail sekali
  const eventIds = [...new Set(eventProducts.map((e) => e.event_id))];
  const flashSaleIds = [
    ...new Set(flashSaleProducts.map((f) => f.flash_sale_id)),
  ];

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

  return products.map((product) => {
    const productVariants = variants.filter((v) => v.product_id === product.id);

    const calcDiscount = (productId, variantId = null) => {
      let discountPercentage = 0;
      let upcomingFlashSale = null;
      const sources = [];
      const details = { events: [], flash_sales: [], store_discounts: [] };

      // === EVENT ===
      eventProducts
        .filter(
          (ep) =>
            ep.product_id === productId &&
            (!variantId || ep.variant_id === variantId),
        )
        .forEach((ep) => {
          const event = eventMap[ep.event_id];
          if (!event) return;
          const start = DateTime.fromISO(event.start_time).toUTC();
          const end = DateTime.fromISO(event.end_time).toUTC();
          if (start <= now && end >= now) {
            discountPercentage = Math.max(
              discountPercentage,
              ep.event_discount,
            );
            if (!sources.includes("event")) sources.push("event");
            details.events.push({ ...event, discount: ep.event_discount });
          }
        });

      // === FLASH SALE ===
      flashSaleProducts
        .filter(
          (fp) =>
            fp.product_id === productId &&
            (!variantId || fp.variant_id === variantId),
        )
        .forEach((fsp) => {
          const flashSale = flashSaleMap[fsp.flash_sale_id];
          if (!flashSale) return;
          const start = DateTime.fromISO(flashSale.start_time).toUTC();
          const end = DateTime.fromISO(flashSale.end_time).toUTC();
          if (flashSale.status === "disabled") {
            details.flash_sales.push({
              ...flashSale,
              discount: fsp.discount_percentage,
              disabled: true,
            });
            return;
          }
          if (flashSale.status === "active") {
            if (start <= now && end >= now) {
              discountPercentage = fsp.discount_percentage;
              if (!sources.includes("flash_sale")) sources.push("flash_sale");
              details.flash_sales.push({
                ...flashSale,
                discount: fsp.discount_percentage,
                ongoing: true,
              });
            } else if (start > now) {
              upcomingFlashSale = fsp.discount_percentage;
              if (!sources.includes("flash_sale_upcoming"))
                sources.push("flash_sale_upcoming");
              details.flash_sales.push({
                ...flashSale,
                discount: fsp.discount_percentage,
                upcoming: true,
              });
            } else {
              details.flash_sales.push({
                ...flashSale,
                discount: fsp.discount_percentage,
                expired: true,
              });
            }
          }
        });

      // === STORE DISCOUNT ===
      const matched =
        (variantId &&
          storeDiscountItems.find(
            (i) => i.product_id === productId && i.variant_id === variantId,
          )) ||
        storeDiscountItems.find(
          (i) => i.product_id === productId && i.variant_id === null,
        );
      if (matched?.store_discounts) {
        const sd = matched.store_discounts;
        const start = DateTime.fromISO(sd.start_time).toUTC();
        const end = DateTime.fromISO(sd.end_time).toUTC();
        if (start <= now && end >= now) {
          if (discountPercentage === 0)
            discountPercentage = matched.discount_percentage;
          if (!sources.includes("store_discount"))
            sources.push("store_discount");
          details.store_discounts.push({
            ...sd,
            discount_percentage: matched.discount_percentage,
          });
        }
      }

      return { discountPercentage, upcomingFlashSale, sources, details };
    };

    // === PRODUK TANPA VARIAN ===
    if (productVariants.length === 0) {
      const discount = calcDiscount(product.id);
      return {
        ...product,
        variants: [],
        finalStock: product.stock,
        finalPrice: applyDiscount(
          product.product_price,
          discount.discountPercentage,
        ),
        discountPercentage: discount.discountPercentage,
        discountSource: discount.sources,
        discountDetails: discount.details,
      };
    }

    // === PRODUK DENGAN VARIAN ===
    const variantsWithDiscount = productVariants.map((v) => {
      const discount = calcDiscount(product.id, v.id);
      let finalPrice = applyDiscount(
        v.variant_price,
        discount.discountPercentage,
      );
      if (discount.upcomingFlashSale !== null)
        finalPrice = Number("3" + finalPrice);
      return {
        ...v,
        original_price: v.variant_price,
        final_price: finalPrice,
        applied_discount: discount.discountPercentage,
        discount_source: discount.sources,
        discount_details: discount.details,
      };
    });

    const finalPrice = Math.min(
      ...variantsWithDiscount.map((v) => v.final_price),
    );
    const maxDiscount = Math.max(
      ...variantsWithDiscount.map((v) => v.applied_discount),
    );

    return {
      ...product,
      variants: variantsWithDiscount,
      finalStock: product.stock,
      finalPrice,
      discountPercentage: maxDiscount,
      discountSource: [
        ...new Set(variantsWithDiscount.flatMap((v) => v.discount_source)),
      ],
    };
  });
}

module.exports = {
  applyDiscount,
  attachVariantsStockDiscountWithRealDiscount,
};
