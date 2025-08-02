const supabase = require("../config/supabase");
const { getActiveDiscountForProduct } = require("./discountHelper");

async function applyDiscountAndVariants(products) {
  if (!products || products.length === 0) return [];

  const ids = products.map((p) => p.id);
  const { data: variants, error } = await supabase
    .from("product_variants")
    .select("*")
    .in("product_id", ids);

  if (error) {
    console.error(error.message);
    return products.map((p) => ({
      ...p,
      variants: [],
      finalStock: p.stock,
      finalPrice: p.product_price,
      discountPercentage: 0,
    }));
  }

  return Promise.all(
    products.map(async (p) => {
      const discountPercentage = await getActiveDiscountForProduct(
        p.id,
        p.seller_id || p.store_id,
      );

      const vList = variants.filter((v) => v.product_id === p.id);
      let finalStock = p.stock;
      if (vList.length > 0) {
        finalStock = vList.reduce((sum, v) => sum + v.variant_stock, 0);
      }

      const discountedVariants = vList.map((v) => ({
        ...v,
        final_price: Math.round(
          v.variant_price * (1 - discountPercentage / 100),
        ),
      }));

      return {
        ...p,
        variants: discountedVariants,
        finalStock,
        finalPrice: Math.round(
          p.product_price * (1 - discountPercentage / 100),
        ),
        discountPercentage,
      };
    }),
  );
}

module.exports = { applyDiscountAndVariants };
