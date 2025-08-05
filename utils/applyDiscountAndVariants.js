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

  // === FLASH SALE PRODUCTS ===
  const { data: flashSaleProducts = [], error: fspErr } = await supabase
    .from("flash_sale_products")
    .select("flash_sale_id,discount_percentage,flash_stock,variant_id")
    .eq("product_id", productId);
  if (fspErr) console.error("FlashSaleProducts error:", fspErr);

  for (const fsp of flashSaleProducts) {
    if (variantId && fsp.variant_id && fsp.variant_id !== variantId) continue;

    const { data: flashSale, error: fsErr } = await supabase
      .from("flash_sales")
      .select("id,start_time,end_time")
      .eq("id", fsp.flash_sale_id)
      .single();
    if (fsErr) console.error("FlashSales error:", fsErr);

    if (flashSale) {
      const start = DateTime.fromISO(flashSale.start_time).toUTC();
      const end = DateTime.fromISO(flashSale.end_time).toUTC();
      if (start <= now && end >= now) {
        discountPercentage = Math.max(
          discountPercentage,
          fsp.discount_percentage,
        );
        if (!sources.includes("flash_sale")) sources.push("flash_sale");
        details.flash_sales.push({
          ...flashSale,
          discount: fsp.discount_percentage,
        });
      }
    }
  }

  // === STORE DISCOUNT ===
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

async function attachVariantsStockDiscount(products) {
  if (!products.length) return [];

  const productIds = products.map((p) => p.id);
  const now = DateTime.utc();

  const { data: flashSaleProducts = [], error: fspErr } = await supabase
    .from("flash_sale_products")
    .select(
      "flash_sale_id,product_id,variant_id,discount_percentage,flash_stock",
    )
    .in("product_id", productIds);
  if (fspErr) console.error("FlashSaleProducts error:", fspErr);

  const flashSaleIds = flashSaleProducts.map((f) => f.flash_sale_id);
  const { data: flashSales = [], error: fsErr } = await supabase
    .from("flash_sales")
    .select("id,start_time,end_time")
    .in("id", flashSaleIds);
  if (fsErr) console.error("FlashSales error:", fsErr);

  const activeFlashSaleProducts = flashSaleProducts.filter((fsp) => {
    const fs = flashSales.find((f) => f.id === fsp.flash_sale_id);
    if (!fs) return false;
    const start = DateTime.fromISO(fs.start_time).toUTC();
    const end = DateTime.fromISO(fs.end_time).toUTC();
    return start <= now && end >= now;
  });

  const { data: variants = [], error: vErr } = await supabase
    .from("product_variants")
    .select("*")
    .in("product_id", productIds);
  if (vErr) console.error("Variants error:", vErr);

  // === Diskon toko (sama seperti sebelumnya) ===
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

  return products.map((product) => {
    const productVariants = variants.filter((v) => v.product_id === product.id);
    const flashForProduct = activeFlashSaleProducts.filter(
      (fsp) => fsp.product_id === product.id,
    );
    const flashSaleDiscount =
      flashForProduct.length > 0
        ? Math.max(...flashForProduct.map((fsp) => fsp.discount_percentage))
        : 0;

    const storeDiscountForProduct = storeDiscountItems.find(
      (i) =>
        i.product_id === product.id &&
        (i.variant_id === null || i.variant_id === undefined),
    );
    const storeDiscountProductPercentage =
      storeDiscountForProduct &&
      DateTime.fromISO(
        storeDiscountForProduct.store_discounts.end_time,
      ).toUTC() >= now
        ? storeDiscountForProduct.discount_percentage
        : 0;

    const finalStock =
      flashForProduct.length > 0
        ? Math.max(...flashForProduct.map((fsp) => fsp.flash_stock))
        : product.stock;

    // === Produk tanpa varian ===
    if (productVariants.length === 0) {
      const discountPercentage = Math.max(
        flashSaleDiscount,
        storeDiscountProductPercentage,
      );
      const discountSource =
        flashSaleDiscount > storeDiscountProductPercentage
          ? "flash_sale"
          : storeDiscountProductPercentage > 0
            ? "store_discount"
            : null;

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
      const flashVariant = flashForProduct.find(
        (fsp) => fsp.variant_id === v.id,
      );
      const flashVariantDiscount =
        flashVariant?.discount_percentage || flashSaleDiscount;

      const storeDiscountForVariant = storeDiscountItems.find(
        (i) => i.variant_id === v.id,
      );
      const storeDiscountVariantPercentage =
        storeDiscountForVariant &&
        DateTime.fromISO(
          storeDiscountForVariant.store_discounts.end_time,
        ).toUTC() >= now
          ? storeDiscountForVariant.discount_percentage
          : storeDiscountProductPercentage;

      const discountPercentage = Math.max(
        flashVariantDiscount,
        storeDiscountVariantPercentage,
      );
      const discountSource =
        flashVariantDiscount > storeDiscountVariantPercentage
          ? "flash_sale"
          : storeDiscountVariantPercentage > 0
            ? "store_discount"
            : null;

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

    return {
      ...product,
      variants: variantsWithDiscount,
      finalStock,
      finalPrice,
      discountPercentage: Math.max(
        storeDiscountProductPercentage,
        flashSaleDiscount,
      ),
      discountSource:
        flashSaleDiscount > storeDiscountProductPercentage
          ? "flash_sale"
          : storeDiscountProductPercentage > 0
            ? "store_discount"
            : null,
    };
  });
}

module.exports = {
  applyDiscount,
  getActiveDiscountForProduct,
  attachVariantsStockDiscount,
};
