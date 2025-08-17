const express = require("express");
const supabase = require("../../config/supabase");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const { DateTime } = require("luxon");
const cron = require("node-cron");
const {
  attachVariantsStockDiscount,
  attachVariantsStockDiscountWithRealDiscount,
} = require("../../utils/applyDiscountAndVariants");

const router = express.Router();

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
async function convertToWebp(buffer) {
  return sharp(buffer).webp({ quality: 80 }).toBuffer();
}

/* ===== EVENT REGISTER PRODUCT (support variant) ===== */
router.post("/event/register", async (req, res) => {
  const { seller_id, event_id, products } = req.body;
  if (!seller_id || !event_id || !Array.isArray(products) || !products.length)
    return res
      .status(400)
      .json({ message: "❌ seller_id, event_id & products wajib" });

  const { data: event } = await supabase
    .from("events")
    .select("*")
    .eq("id", event_id)
    .single();
  if (!event)
    return res.status(404).json({ message: "❌ Event tidak ditemukan" });

  const rows = [];

  for (const p of products) {
    if (p.variant_id) {
      const { data: variant } = await supabase
        .from("product_variants")
        .select("*")
        .eq("id", p.variant_id)
        .single();
      if (!variant) continue;

      await supabase
        .from("product_variants")
        .update({ variant_stock: (variant.variant_stock || 0) - p.event_stock })
        .eq("id", p.variant_id);

      rows.push({
        seller_id,
        event_id,
        product_id: p.product_id,
        variant_id: p.variant_id,
        event_discount: p.discount_percentage,
        event_stock: p.event_stock,
      });
    } else {
      const { data: product } = await supabase
        .from("products")
        .select("*")
        .eq("id", p.product_id)
        .single();
      if (!product) continue;

      await supabase
        .from("products")
        .update({ stock: (product.stock || 0) - p.event_stock })
        .eq("id", p.product_id);

      rows.push({
        seller_id,
        event_id,
        product_id: p.product_id,
        variant_id: null,
        event_discount: p.discount_percentage,
        event_stock: p.event_stock,
      });
    }
  }

  const { error } = await supabase.from("event_products").insert(rows);
  if (error)
    return res.status(500).json({
      message: "❌ Gagal daftar produk ke event",
      error: error.message,
    });

  res.json({ message: "✅ Produk berhasil didaftarkan ke event" });
});


/* ===== EVENT LIST ===== */
router.get("/event/list", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("events")
      .select("*")
      .order("start_time", { ascending: false });

    if (error)
      return res
        .status(500)
        .json({ message: "❌ Gagal ambil event", error: error.message });
    res.json({ message: "✅ Daftar event", data });
  } catch (err) {
    res.status(500).json({ message: "❌ Error server", error: err.message });
  }
});

/* ===== Event Detail ===== */
router.get("/event/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: event, error } = await supabase
      .from("events")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !event) {
      return res.status(404).json({ message: "❌ Event tidak ditemukan" });
    }

    const { data: eventProducts = [] } = await supabase
      .from("event_products")
      .select("products(*)")
      .eq("event_id", id);

    const products = (eventProducts || [])
      .map((p) => p.products)
      .filter(Boolean);
    const productsWithDiscount =
      products.length > 0 ? await attachVariantsStockDiscount(products) : [];

    return res.json({
      message: "✅ Detail event",
      event,
      products: productsWithDiscount,
    });
  } catch (err) {
    res.status(500).json({ message: "❌ Error server", error: err.message });
  }
});

/* ===== SELLER REGISTER PRODUK KE FLASH SALE ===== */
/* ===== REGISTER PRODUK FLASH SALE ===== */
router.post("/flash-sale/register", async (req, res) => {
  try {
    const { seller_id, flash_sale_id, products } = req.body;

    if (
      !seller_id ||
      flash_sale_id === undefined ||
      !Array.isArray(products) ||
      !products.length
    ) {
      return res.status(400).json({
        message: "❌ seller_id, flash_sale_id & products wajib diisi",
      });
    }

    const flashSaleId = Number(flash_sale_id);
    const { data: flashSale, error: flashSaleErr } = await supabase
      .from("flash_sales")
      .select("*")
      .eq("id", flashSaleId)
      .single();

    if (flashSaleErr || !flashSale) {
      return res.status(404).json({ message: "❌ Flash sale tidak ditemukan" });
    }

    // 🔴 Cek produk sudah ada di flash_sale_products untuk sesi ini
    const { data: existingProducts, error: existErr } = await supabase
      .from("flash_sale_products")
      .select("product_id, variant_id")
      .eq("flash_sale_id", flashSaleId);

    if (existErr) {
      return res.status(500).json({
        message: "❌ Gagal memeriksa produk yang sudah terdaftar",
        error: existErr,
      });
    }

    const existingSet = new Set(
      existingProducts.map(
        (p) => `${p.product_id}-${p.variant_id ?? "no-variant"}`,
      ),
    );

    const rows = [];

    for (const p of products) {
      if (p.discount_percentage === undefined) {
        return res.status(400).json({
          message: `❌ Produk ${p.product_id} harus menyertakan discount_percentage`,
        });
      }

      const key = `${p.product_id}-${p.variant_id ?? "no-variant"}`;
      if (existingSet.has(key)) {
        return res.status(400).json({
          message: `❌ Produk ${p.product_id}${
            p.variant_id ? " (variant " + p.variant_id + ")" : ""
          } sudah terdaftar di flash sale ini`,
        });
      }

      if (p.variant_id) {
        const { data: variant } = await supabase
          .from("product_variants")
          .select("*")
          .eq("id", p.variant_id)
          .single();
        if (!variant) continue;

        await supabase
          .from("product_variants")
          .update({
            variant_stock: (variant.variant_stock || 0) - p.flash_stock,
          })
          .eq("id", p.variant_id);

        rows.push({
          seller_id,
          flash_sale_id: flashSaleId,
          product_id: p.product_id,
          variant_id: p.variant_id,
          flash_stock: p.flash_stock,
          discount_percentage: p.discount_percentage,
        });
      } else {
        const { data: product } = await supabase
          .from("products")
          .select("*")
          .eq("id", p.product_id)
          .single();
        if (!product) continue;

        await supabase
          .from("products")
          .update({ stock: (product.stock || 0) - p.flash_stock })
          .eq("id", p.product_id);

        rows.push({
          seller_id,
          flash_sale_id: flashSaleId,
          product_id: p.product_id,
          variant_id: null,
          flash_stock: p.flash_stock,
          discount_percentage: p.discount_percentage,
        });
      }
    }

    if (!rows.length) {
      return res.status(400).json({
        message: "❌ Tidak ada produk valid untuk ditambahkan",
      });
    }

    const { error } = await supabase.from("flash_sale_products").insert(rows);
    if (error) {
      return res.status(500).json({
        message: "❌ Gagal daftar produk ke flash sale",
        error,
      });
    }

    return res.json({
      message: "✅ Produk berhasil didaftarkan ke flash sale",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server",
      error: err.message,
    });
  }
});

/* ===== GET LIST FLASH SALE (Khusus Untuk Seller) ===== */
router.get("/flash-sale/list", async (req, res) => {
  try {
    // Ambil semua flash sale (bisa difilter status)
    const { data: flashSales, error } = await supabase
      .from("flash_sales")
      .select("*")
      .order("start_time", { ascending: true });

    if (error) {
      return res
        .status(500)
        .json({ message: "❌ Gagal mengambil daftar flash sale", error });
    }

    return res.json({
      message: `✅ ${flashSales.length} flash sale ditemukan`,
      flash_sales: flashSales,
    });
  } catch (err) {
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server",
      error: err.message,
    });
  }
});

/* ===== FLASH SALE GET BY ID ===== */
router.get("/flash-sale/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: flashSale, error } = await supabase
      .from("flash_sales")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !flashSale) {
      return res.status(404).json({ message: "❌ Flash sale tidak ditemukan" });
    }

    const { data: product } = await supabase
      .from("products")
      .select("*")
      .eq("id", flashSale.product_id)
      .single();

    const productsWithDiscount = product
      ? await attachVariantsStockDiscount([product])
      : [];

    return res.json({
      message: "✅ Detail flash sale",
      flash_sale: flashSale,
      product: productsWithDiscount[0] || null,
    });
  } catch (err) {
    res.status(500).json({ message: "❌ Error server", error: err.message });
  }
});


/* ===== STORE DISCOUNT CREATE ===== */
router.post("/store-discount/create", async (req, res) => {
  // Seller dari cookies
  const sellerInfo = req.cookies?.seller_info
    ? JSON.parse(req.cookies.seller_info)
    : null;

  if (!sellerInfo?.id) {
    return res.status(401).json({ error: "❌ Harus login sebagai seller" });
  }

  const { name, start_time, end_time, timezone, items } = req.body;

  if (!name || !items?.length || !start_time || !end_time) {
    return res.status(400).json({
      message: "❌ name, start_time, end_time & items wajib diisi",
    });
  }

  const tz = timezone || "Asia/Jakarta";
  const startUTC = DateTime.fromISO(start_time, { zone: tz }).toUTC().toISO();
  const endUTC = DateTime.fromISO(end_time, { zone: tz }).toUTC().toISO();

  try {
    const { data: storeDiscount, error: sdErr } = await supabase
      .from("store_discounts")
      .insert([
        { store_id: sellerInfo.id, name, start_time: startUTC, end_time: endUTC },
      ])
      .select()
      .single();

    if (sdErr) {
      return res.status(500).json({
        message: "❌ Gagal simpan diskon toko",
        error: sdErr.message,
      });
    }

    // Insert item discount
    for (const item of items) {
      await supabase.from("store_discount_items").insert([
        {
          discount_id: storeDiscount.id,
          product_id: item.product_id,
          variant_id: item.variant_id || null,
          stock: item.stock,
          discount_percentage: item.discount_percentage,
        },
      ]);
    }

    return res.json({
      message: "✅ Diskon toko berhasil dibuat dengan item-target",
      store_discount: storeDiscount,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "❌ Error server",
      error: err.message,
    });
  }
});

/* ===== GET ALL STORE DISCOUNT (BY SELLER - pakai cookies) ===== */
router.get("/store-discount/all", async (req, res) => {
  // Seller dari cookies
  const sellerInfo = req.cookies?.seller_info
    ? JSON.parse(req.cookies.seller_info)
    : null;

  if (!sellerInfo?.id) {
    return res.status(401).json({ error: "❌ Harus login sebagai seller" });
  }

  try {
    const { data: storeDiscounts, error } = await supabase
      .from("store_discounts")
      .select("*")
      .eq("store_id", sellerInfo.id)
      .order("start_time", { ascending: true });

    if (error) {
      return res.status(500).json({ message: "❌ Gagal ambil semua diskon toko" });
    }

    const discountsWithItems = [];
    for (const discount of storeDiscounts || []) {
      const { data: items = [] } = await supabase
        .from("store_discount_items")
        .select("*, products(*), product_variants(*)")
        .eq("discount_id", discount.id);

      discountsWithItems.push({ ...discount, items });
    }

    return res.json({
      message: "✅ Semua diskon milik seller berhasil diambil",
      data: discountsWithItems,
    });
  } catch (err) {
    console.error("❌ Error get seller discounts:", err);
    res.status(500).json({ message: "❌ Error server", error: err.message });
  }
});

router.post("/:id/duplicate", async (req, res) => {
  const discountId = req.params.id;

  try {
    const { data: original, error: fetchErr } = await supabase
      .from("discounts")
      .select("*")
      .eq("id", discountId)
      .single();

    if (fetchErr) throw fetchErr;
    if (!original) {
      return res.status(404).json({ error: "Discount tidak ditemukan" });
    }

    const duplicated = {
      ...original,
      id: uuidv4(),
      name: original.name + " (Copy)",
      created_at: new Date().toISOString(),
    };
    delete duplicated.updated_at;

    const { data, error } = await supabase
      .from("discounts")
      .insert([duplicated])
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});





/* ===== UPDATE STORE DISCOUNT (PUT) ===== */
router.put("/store-discount/:id", async (req, res) => {
  const discountId = req.params.id;

  // Seller dari cookies
  const sellerInfo = req.cookies?.seller_info
    ? JSON.parse(req.cookies.seller_info)
    : null;

  if (!sellerInfo?.id) {
    return res.status(401).json({ error: "❌ Harus login sebagai seller" });
  }

  const { name, start_time, end_time, timezone, items } = req.body;

  if (!name || !start_time || !end_time) {
    return res.status(400).json({
      message: "❌ name, start_time, end_time wajib diisi",
    });
  }

  const tz = timezone || "Asia/Jakarta";
  const startUTC = DateTime.fromISO(start_time, { zone: tz }).toUTC().toISO();
  const endUTC = DateTime.fromISO(end_time, { zone: tz }).toUTC().toISO();

  try {
    // Pastikan diskon ini milik seller
    const { data: discount, error: findErr } = await supabase
      .from("store_discounts")
      .select("*")
      .eq("id", discountId)
      .eq("store_id", sellerInfo.id)
      .single();

    if (findErr || !discount) {
      return res
        .status(404)
        .json({ error: "❌ Diskon tidak ditemukan atau bukan milik Anda" });
    }

    // Update diskon
    const { data: updatedDiscount, error: updErr } = await supabase
      .from("store_discounts")
      .update({
        name,
        start_time: startUTC,
        end_time: endUTC,
      })
      .eq("id", discountId)
      .select()
      .single();

    if (updErr) {
      return res.status(500).json({ error: "❌ Gagal update diskon" });
    }

    // Update items (hapus lama → insert baru)
    if (items?.length) {
      await supabase.from("store_discount_items").delete().eq("discount_id", discountId);

      for (const item of items) {
        await supabase.from("store_discount_items").insert([
          {
            discount_id: discountId,
            product_id: item.product_id,
            variant_id: item.variant_id || null,
            stock: item.stock,
            discount_percentage: item.discount_percentage,
          },
        ]);
      }
    }

    res.json({
      message: "✅ Diskon toko berhasil diupdate",
      data: updatedDiscount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "❌ Error server", detail: err.message });
  }
});

/* ===== DELETE STORE DISCOUNT (DELETE) ===== */
router.delete("/store-discount/:id", async (req, res) => {
  const discountId = req.params.id;

  // Seller dari cookies
  const sellerInfo = req.cookies?.seller_info
    ? JSON.parse(req.cookies.seller_info)
    : null;

  if (!sellerInfo?.id) {
    return res.status(401).json({ error: "❌ Harus login sebagai seller" });
  }

  try {
    // Pastikan diskon ini milik seller
    const { data: discount, error: findErr } = await supabase
      .from("store_discounts")
      .select("id")
      .eq("id", discountId)
      .eq("store_id", sellerInfo.id)
      .single();

    if (findErr || !discount) {
      return res
        .status(404)
        .json({ error: "❌ Diskon tidak ditemukan atau bukan milik Anda" });
    }

    // Hapus item terkait
    await supabase.from("store_discount_items").delete().eq("discount_id", discountId);

    // Hapus diskon
    const { error: delErr } = await supabase
      .from("store_discounts")
      .delete()
      .eq("id", discountId);

    if (delErr) {
      return res.status(500).json({ error: "❌ Gagal hapus diskon" });
    }

    res.json({ message: "✅ Diskon toko berhasil dihapus" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "❌ Error server", detail: err.message });
  }
});


module.exports = router;
