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

  // ====== Kalkulasi Diskon dan Stok dengan Prioritas ======
  const calcDiscountAndStock = (productId, variantId = null) => {
    const activeDiscounts = {
      flash_sale: null,
      event: null,
      store_discount: null,
    };
    let totalStock = 0; // Untuk menghitung stok total

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

        const start = DateTime.fromISO(event.start_time).toUTC();
        const end = DateTime.fromISO(event.end_time).toUTC();
        if (start <= now && end >= now) {
          // Tambahkan stok event jika ada
          if (ep.event_stock !== null && ep.event_stock > 0) {
            totalStock += ep.event_stock;
            activeDiscounts.event = {
              discount: ep.event_discount,
              source: "event",
              details: { ...event, discount: ep.event_discount },
            };
          }
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
        if (!flashSale || flashSale.status === "disabled") return;

        const start = DateTime.fromISO(flashSale.start_time).toUTC();
        const end = DateTime.fromISO(flashSale.end_time).toUTC();
        if (flashSale.status === "active" && start <= now && end >= now) {
          // Tambahkan stok flash sale jika ada
          if (fsp.flash_stock !== null && fsp.flash_stock > 0) {
            totalStock += fsp.flash_stock;
            activeDiscounts.flash_sale = {
              discount: fsp.discount_percentage,
              source: "flash_sale",
              details: { ...flashSale, discount: fsp.discount_percentage },
            };
          }
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
      const sd = matched.store_discounts;
      const start = DateTime.fromISO(sd.start_time).toUTC();
      const end = DateTime.fromISO(sd.end_time).toUTC();
      if (start <= now && end >= now) {
        // Tambahkan stok store discount jika ada
        if (matched.stock !== null && matched.stock > 0) {
          totalStock += matched.stock;
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
      totalStock, // Stok total dari semua sumber
    };
  };

  // ====== Proses Produk ======
  return products.map((product) => {
    const productVariants = variants.filter((v) => v.product_id === product.id);

    // === Produk tanpa varian ===
    if (productVariants.length === 0) {
      const discountAndStock = calcDiscountAndStock(product.id);
      // Tambahkan stok asli produk dengan stok diskon dan timpa field stock
      const totalStock = (product.stock || 0) + discountAndStock.totalStock;
      return {
        ...product,
        stock: totalStock > 0 ? totalStock : 0, // Timpa field stock
        variants: [],
        finalPrice: applyDiscount(
          product.product_price,
          discountAndStock.discountPercentage
        ),
        discountPercentage: discountAndStock.discountPercentage,
        discountSource: discountAndStock.sources,
        discountDetails: discountAndStock.details,
      };
    }

    // === Produk dengan varian ===
    const variantsWithDiscount = productVariants.map((v) => {
      const discountAndStock = calcDiscountAndStock(product.id, v.id);
      const finalPrice = applyDiscount(
        v.variant_price,
        discountAndStock.discountPercentage
      );
      // Tambahkan stok asli varian dengan stok diskon
      const totalStock = (v.variant_stock || 0) + discountAndStock.totalStock;

      return {
        id: v.id,
        variant_name: v.variant_name,
        variant_price: v.variant_price,
        variant_image_url: v.variant_image_url,
        variant_stock: totalStock > 0 ? totalStock : 0, // Pastikan stok tidak negatif
        original_price: v.variant_price,
        final_price: finalPrice,
        applied_discount: discountAndStock.discountPercentage,
        discount_source: discountAndStock.sources,
        discount_details: discountAndStock.details,
      };
    });

    return {
      ...product,
      variants: variantsWithDiscount,
      stock: product.stock, // Stok produk utama tetap dari field asli
    };
  });
}

module.exports = {
  applyDiscount,
  attachVariantsStockDiscountWithRealDiscount,
};