const supabase = require("../config/supabase");

// === Ambil diskon aktif untuk 1 produk ===
async function getActiveDiscountForProduct(productId, storeId) {
  const now = new Date().toISOString();

  // === Diskon Toko Aktif ===
  const { data: storeDiscounts } = await supabase
    .from("store_discounts")
    .select("*")
    .eq("store_id", storeId)
    .lte("start_time", now)
    .gte("end_time", now);

  // === Event Global Aktif ===
  const { data: events } = await supabase
    .from("events")
    .select("*")
    .lte("start_time", now)
    .gte("end_time", now);

  // === Flash Sale Aktif (produk spesifik) ===
  const { data: flashSales } = await supabase
    .from("flash_sales")
    .select("*")
    .eq("product_id", productId)
    .lte("start_time", now)
    .gte("end_time", now);

  let discountPercentage = 0;

  // Event global (contoh: fix 10%)
  if (events?.length > 0) discountPercentage = Math.max(discountPercentage, 10);

  // Diskon toko
  if (storeDiscounts?.length > 0) {
    for (const d of storeDiscounts) {
      discountPercentage = Math.max(discountPercentage, d.percentage);
    }
  }

  // Flash sale
  if (flashSales?.length > 0) {
    for (const fs of flashSales) {
      discountPercentage = Math.max(discountPercentage, fs.discount_percentage);
    }
  }

  return discountPercentage;
}

module.exports = { getActiveDiscountForProduct };
