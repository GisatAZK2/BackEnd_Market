const supabase = require("../config/supabase");
const { DateTime } = require("luxon");

function applyDiscount(price, discountPercentage) {
  return Math.round(price * (1 - discountPercentage / 100));
}

/**
 * Ambil diskon aktif + detail event/flash sale/diskon toko
 * @param {string} productId
 * @param {string} storeId
 * @returns {Promise<{discountPercentage:number, sources:string[], details:{events:[],flash_sales:[],store_discounts:[]} }>}
 */
async function getActiveDiscountForProduct(productId, storeId) {
  const now = DateTime.utc();
  let discountPercentage = 0;
  const sources = [];
  const details = {
    events: [],
    flash_sales: [],
    store_discounts: [],
  };

  // === EVENT PRODUCT (hanya event aktif) ===
  const { data: eventProducts } = await supabase
    .from("event_products")
    .select("event_discount,event_id")
    .eq("product_id", productId);

  if (eventProducts?.length) {
    for (const ep of eventProducts) {
      const { data: event } = await supabase
        .from("events")
        .select("id,title,start_time,end_time")
        .eq("id", ep.event_id)
        .single();

      if (event) {
        const start = DateTime.fromISO(event.start_time);
        const end = DateTime.fromISO(event.end_time);

        if (start <= now && end >= now) {
          if (ep.event_discount > discountPercentage) {
            discountPercentage = ep.event_discount;
          }
          if (!sources.includes("event")) sources.push("event");
          details.events.push({
            id: event.id,
            title: event.title,
            start_time: event.start_time,
            end_time: event.end_time,
            discount: ep.event_discount,
          });
        }
      }
    }
  }

  // === FLASH SALE (hanya yang aktif) ===
  const { data: flashSales } = await supabase
    .from("flash_sales")
    .select("id,discount_percentage,start_time,end_time")
    .eq("product_id", productId);

  if (flashSales?.length) {
    for (const fs of flashSales) {
      const start = DateTime.fromISO(fs.start_time);
      const end = DateTime.fromISO(fs.end_time);

      if (start <= now && end >= now) {
        if (fs.discount_percentage > discountPercentage) {
          discountPercentage = fs.discount_percentage;
        }
        if (!sources.includes("flash_sale")) sources.push("flash_sale");
        details.flash_sales.push({
          id: fs.id,
          start_time: fs.start_time,
          end_time: fs.end_time,
          discount: fs.discount_percentage,
        });
      }
    }
  }

  // === STORE DISCOUNT (hanya yang aktif) ===
  const { data: storeDiscounts } = await supabase
    .from("store_discounts")
    .select("id,percentage,start_time,end_time")
    .eq("store_id", storeId);

  if (storeDiscounts?.length) {
    for (const sd of storeDiscounts) {
      const start = DateTime.fromISO(sd.start_time);
      const end = DateTime.fromISO(sd.end_time);

      if (start <= now && end >= now) {
        if (sd.percentage > discountPercentage) {
          discountPercentage = sd.percentage;
        }
        if (!sources.includes("store_discount")) sources.push("store_discount");
        details.store_discounts.push({
          id: sd.id,
          start_time: sd.start_time,
          end_time: sd.end_time,
          discount: sd.percentage,
        });
      }
    }
  }

  return { discountPercentage, sources, details };
}

async function attachVariantsStockDiscount(products) {
  const productIds = products.map((p) => p.id);
  const { data: variants } = await supabase
    .from("product_variants")
    .select("*")
    .in("product_id", productIds);

  const results = [];
  for (const product of products) {
    const { discountPercentage, sources, details } =
      await getActiveDiscountForProduct(product.id, product.seller_id);

    const productVariants = variants.filter((v) => v.product_id === product.id);

    if (productVariants.length > 0) {
      const variantsWithFinal = productVariants.map((v) => ({
        ...v,
        original_price: v.variant_price,
        final_price: applyDiscount(v.variant_price, discountPercentage),
      }));

      const finalStock = variantsWithFinal.reduce(
        (sum, v) => sum + (v.variant_stock || 0),
        0,
      );

      const minFinalPrice = Math.min(
        ...variantsWithFinal.map((v) => v.final_price),
      );

      results.push({
        ...product,
        variants: variantsWithFinal,
        finalStock,
        discountPercentage,
        discountSources: sources,
        discountDetails: details,
        finalPrice: minFinalPrice,
      });
    } else {
      results.push({
        ...product,
        variants: [],
        finalStock: product.stock || 0,
        discountPercentage,
        discountSources: sources,
        discountDetails: details,
        finalPrice: applyDiscount(product.product_price, discountPercentage),
      });
    }
  }

  return results;
}

module.exports = {
  applyDiscount,
  getActiveDiscountForProduct,
  attachVariantsStockDiscount,
};
