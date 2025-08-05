const supabase = require("../config/supabase");
const { DateTime } = require("luxon");

function applyDiscount(price, discountPercentage) {
  return Math.round(price * (1 - discountPercentage / 100));
}

async function getActiveDiscountForProduct(
  productId,
  storeId,
  variantId = null,
) {
  const now = DateTime.utc();
  let discountPercentage = 0;
  let upcomingFlashSale = null; // flag kalau ada upcoming flash sale
  const sources = [];
  const details = { events: [], flash_sales: [], store_discounts: [] };

  /* === EVENT PRODUCT === */
  const { data: eventProducts = [] } = await supabase
    .from("event_products")
    .select("event_discount,event_id,variant_id")
    .eq("product_id", productId);

  for (const ep of eventProducts) {
    if (variantId && ep.variant_id && ep.variant_id !== variantId) continue;

    const { data: event } = await supabase
      .from("events")
      .select("id,title,start_time,end_time")
      .eq("id", ep.event_id)
      .single();

    if (!event) continue;
    const start = DateTime.fromISO(event.start_time).toUTC();
    const end = DateTime.fromISO(event.end_time).toUTC();

    if (start <= now && end >= now) {
      discountPercentage = Math.max(discountPercentage, ep.event_discount);
      if (!sources.includes("event")) sources.push("event");
      details.events.push({ ...event, discount: ep.event_discount });
    }
  }

  /* === FLASH SALE === */
  const { data: flashSaleProducts = [] } = await supabase
    .from("flash_sale_products")
    .select("flash_sale_id,discount_percentage,variant_id")
    .eq("product_id", productId);

  for (const fsp of flashSaleProducts) {
    if (variantId && fsp.variant_id && fsp.variant_id !== variantId) continue;

    const { data: flashSale } = await supabase
      .from("flash_sales")
      .select("id,start_time,end_time,status")
      .eq("id", fsp.flash_sale_id)
      .single();

    if (!flashSale) continue;
    const start = DateTime.fromISO(flashSale.start_time).toUTC();
    const end = DateTime.fromISO(flashSale.end_time).toUTC();

    if (flashSale.status === "disabled") {
      // abaikan → balik ke normal/event/store
      details.flash_sales.push({
        ...flashSale,
        discount: fsp.discount_percentage,
        disabled: true,
      });
      continue;
    }

    if (flashSale.status === "active") {
      if (start <= now && end >= now) {
        // sedang berjalan
        discountPercentage = fsp.discount_percentage;
        if (!sources.includes("flash_sale")) sources.push("flash_sale");
        details.flash_sales.push({
          ...flashSale,
          discount: fsp.discount_percentage,
          ongoing: true,
        });
      } else if (start > now) {
        // upcoming
        upcomingFlashSale = fsp.discount_percentage;
        if (!sources.includes("flash_sale_upcoming"))
          sources.push("flash_sale_upcoming");
        details.flash_sales.push({
          ...flashSale,
          discount: fsp.discount_percentage,
          upcoming: true,
        });
      } else if (end < now) {
        // sudah selesai → fallback
        details.flash_sales.push({
          ...flashSale,
          discount: fsp.discount_percentage,
          expired: true,
        });
      }
    }
  }

  /* === STORE DISCOUNT === */
  const { data: storeDiscountItems = [] } = await supabase
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

  const matched =
    (variantId && storeDiscountItems.find((i) => i.variant_id === variantId)) ||
    storeDiscountItems.find((i) => i.variant_id === null);

  if (matched?.store_discounts) {
    const sd = matched.store_discounts;
    const start = DateTime.fromISO(sd.start_time).toUTC();
    const end = DateTime.fromISO(sd.end_time).toUTC();
    if (start <= now && end >= now) {
      // hanya dipakai kalau tidak di override flash sale active
      if (discountPercentage === 0) {
        discountPercentage = matched.discount_percentage;
      }
      if (!sources.includes("store_discount")) sources.push("store_discount");
      details.store_discounts.push({
        ...sd,
        discount_percentage: matched.discount_percentage,
      });
    }
  }

  return { discountPercentage, upcomingFlashSale, sources, details };
}

async function attachVariantsStockDiscountWithRealDiscount(products) {
  if (!products.length) return [];

  const productIds = products.map((p) => p.id);
  const { data: variants = [] } = await supabase
    .from("product_variants")
    .select("*")
    .in("product_id", productIds);

  return Promise.all(
    products.map(async (product) => {
      const productVariants = variants.filter(
        (v) => v.product_id === product.id,
      );

      // === produk tanpa varian ===
      if (productVariants.length === 0) {
        const discount = await getActiveDiscountForProduct(
          product.id,
          product.store_id,
        );
        let finalPrice = applyDiscount(
          product.product_price,
          discount.discountPercentage,
        );

        // kalau upcoming → tambahkan prefix 3
        if (discount.upcomingFlashSale !== null) {
          finalPrice = Number("3" + finalPrice);
        }

        return {
          ...product,
          variants: [],
          finalStock: product.stock,
          finalPrice,
          discountPercentage: discount.discountPercentage,
          discountSource: discount.sources,
          discountDetails: discount.details,
        };
      }

      // === produk dengan varian ===
      const variantsWithDiscount = await Promise.all(
        productVariants.map(async (v) => {
          const discount = await getActiveDiscountForProduct(
            product.id,
            product.store_id,
            v.id,
          );
          let finalPrice = applyDiscount(
            v.variant_price,
            discount.discountPercentage,
          );

          if (discount.upcomingFlashSale !== null) {
            finalPrice = Number("3" + finalPrice);
          }

          return {
            ...v,
            original_price: v.variant_price,
            final_price: finalPrice,
            applied_discount: discount.discountPercentage,
            discount_source: discount.sources,
            discount_details: discount.details,
          };
        }),
      );

      const finalPrice = Math.min(
        ...variantsWithDiscount.map((v) => v.final_price),
      );

      return {
        ...product,
        variants: variantsWithDiscount,
        finalStock: product.stock,
        finalPrice,
        discountPercentage: Math.max(
          ...variantsWithDiscount.map((v) => v.applied_discount),
        ),
        discountSource: [
          ...new Set(variantsWithDiscount.flatMap((v) => v.discount_source)),
        ],
      };
    }),
  );
}

module.exports = {
  applyDiscount,
  getActiveDiscountForProduct,
  attachVariantsStockDiscountWithRealDiscount,
};
