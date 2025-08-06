// routes/sellerWithProducts.js
const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const {
  attachVariantsStockDiscountWithRealDiscount,
} = require("../utils/applyDiscountAndVariants");
const { DateTime } = require("luxon");

// GET Seller beserta produk-produknya
router.get("/:id", async (req, res) => {
  const sellerId = req.params.id;

  if (!sellerId) {
    return res.status(400).json({ message: "❌ seller_id wajib diisi" });
  }

  try {
    // Ambil detail seller
    const { data: seller, error: sellerError } = await supabase
      .from("sellers")
      .select("*")
      .eq("id", sellerId)
      .single();

    if (sellerError || !seller) {
      return res.status(404).json({ message: "❌ Seller tidak ditemukan" });
    }

    // Ambil semua produk milik seller
    const { data: products, error: productError } = await supabase
      .from("products")
      .select("*")
      .eq("seller_id", sellerId);

    if (productError) {
      return res.status(500).json({
        message: "❌ Gagal mengambil produk seller",
        error: productError.message,
      });
    }

    // Tambahkan varian, stok, dan diskon
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(products);

    return res.status(200).json({
      message: `✅ Seller & ${productsWithVariants.length} produk berhasil diambil`,
      seller,
      products: productsWithVariants,
    });
  } catch (error) {
    return res.status(500).json({
      message: "❌ Gagal mengambil data seller beserta produk",
      error: error.message,
    });
  }
});

module.exports = router;
