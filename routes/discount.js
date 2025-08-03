const express = require("express");
const supabase = require("../config/supabase");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const { DateTime } = require("luxon");
const cron = require("node-cron");
const {
  attachVariantsStockDiscount,
} = require("../utils/applyDiscountAndVariants");

const router = express.Router();

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
async function convertToWebp(buffer) {
  return sharp(buffer).webp({ quality: 80 }).toBuffer();
}

/* ===== EVENT CREATE ===== */
router.post("/event", upload.single("banner"), async (req, res) => {
  const { title, description, start_time, end_time, timezone } = req.body;
  if (!title || !start_time || !end_time)
    return res
      .status(400)
      .json({ message: "❌ title, start_time, end_time wajib" });

  const tz = timezone || "Asia/Jakarta";
  const startUTC = DateTime.fromISO(start_time, { zone: tz }).toUTC().toISO();
  const endUTC = DateTime.fromISO(end_time, { zone: tz }).toUTC().toISO();

  let banner_url = null;
  if (req.file) {
    const filePath = `events/${uuidv4()}.webp`;
    const webpBuffer = await convertToWebp(req.file.buffer);
    await supabase.storage.from("event-banners").upload(filePath, webpBuffer, {
      contentType: "image/webp",
      upsert: true,
    });
    banner_url = supabase.storage.from("event-banners").getPublicUrl(filePath)
      .data.publicUrl;
  }

  const { data, error } = await supabase
    .from("events")
    .insert([
      {
        title,
        description,
        banner_url,
        start_time: startUTC,
        end_time: endUTC,
      },
    ])
    .select()
    .single();

  if (error)
    return res.status(500).json({ message: "❌ Gagal simpan event", error });
  res.json({ message: "✅ Event berhasil ditambahkan", data });
});

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
      // --- Kurangi stok variant ---
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
      // --- Kurangi stok produk utama ---
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

/* ===== FLASH SALE CREATE ===== */
router.post("/flash-sale/create", async (req, res) => {
  const {
    product_id,
    variant_id, // optional
    discount_percentage,
    flash_stock,
    start_time,
    end_time,
    timezone,
  } = req.body;

  if (
    !product_id ||
    !discount_percentage ||
    !flash_stock ||
    !start_time ||
    !end_time
  ) {
    return res.status(400).json({ message: "❌ Semua field wajib diisi" });
  }

  const tz = timezone || "Asia/Jakarta";
  const startUTC = DateTime.fromISO(start_time, { zone: tz }).toUTC().toISO();
  const endUTC = DateTime.fromISO(end_time, { zone: tz }).toUTC().toISO();

  // ambil produk
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("*")
    .eq("id", product_id)
    .single();

  if (productError || !product) {
    return res.status(404).json({ message: "❌ Produk tidak ditemukan" });
  }

  // jika ada variant_id, cek varian
  if (variant_id) {
    const { data: variant, error: variantError } = await supabase
      .from("product_variants")
      .select("*")
      .eq("id", variant_id)
      .eq("product_id", product_id)
      .single();

    if (variantError || !variant) {
      return res.status(404).json({ message: "❌ Varian tidak ditemukan" });
    }

    // update stok khusus varian
    await supabase
      .from("product_variants")
      .update({ variant_stock: (variant.variant_stock || 0) - flash_stock })
      .eq("id", variant_id);
  } else {
    // update stok produk langsung
    await supabase
      .from("products")
      .update({ stock: (product.stock || 0) - flash_stock })
      .eq("id", product_id);
  }

  const { data, error } = await supabase
    .from("flash_sales")
    .insert([
      {
        product_id,
        variant_id: variant_id || null,
        discount_percentage,
        flash_stock,
        start_time: startUTC,
        end_time: endUTC,
      },
    ])
    .select()
    .single();

  if (error) {
    return res
      .status(500)
      .json({ message: "❌ Gagal simpan flash sale", error });
  }

  // refresh detail produk setelah diskon
  const productsWithDiscount = await attachVariantsStockDiscount([product]);

  res.json({
    message: "✅ Flash sale berhasil ditambahkan",
    data,
    product: productsWithDiscount[0],
  });
});

/* ===== STORE DISCOUNT CREATE ===== */
router.post("/store-discount/create", async (req, res) => {
  const {
    store_id,
    name, // Nama diskon
    start_time,
    end_time,
    timezone,
    items, // [{ product_id, variant_id?, stock, discount_percentage }]
  } = req.body;

  if (!store_id || !name || !items?.length || !start_time || !end_time) {
    return res.status(400).json({
      message: "❌ store_id, name, start_time, end_time & items wajib diisi",
    });
  }

  const tz = timezone || "Asia/Jakarta";
  const startUTC = DateTime.fromISO(start_time, { zone: tz }).toUTC().toISO();
  const endUTC = DateTime.fromISO(end_time, { zone: tz }).toUTC().toISO();

  try {
    // === 1. Simpan data utama diskon (tanpa persentase global)
    const { data: storeDiscount, error: sdErr } = await supabase
      .from("store_discounts")
      .insert([
        {
          store_id,
          name,
          start_time: startUTC,
          end_time: endUTC,
        },
      ])
      .select()
      .single();

    if (sdErr) {
      return res.status(500).json({
        message: "❌ Gagal simpan diskon toko",
        error: sdErr.message,
      });
    }

    // === 2. Simpan setiap item target diskon
    for (const item of items) {
      // Kurangi stok produk/varian
      if (item.variant_id) {
        const { data: variant } = await supabase
          .from("product_variants")
          .select("variant_stock")
          .eq("id", item.variant_id)
          .single();

        if (variant) {
          await supabase
            .from("product_variants")
            .update({
              variant_stock: Math.max(
                (variant.variant_stock || 0) - (item.stock || 0),
                0,
              ),
            })
            .eq("id", item.variant_id);
        }
      } else {
        const { data: product } = await supabase
          .from("products")
          .select("stock")
          .eq("id", item.product_id)
          .single();

        if (product) {
          await supabase
            .from("products")
            .update({
              stock: Math.max((product.stock || 0) - (item.stock || 0), 0),
            })
            .eq("id", item.product_id);
        }
      }

      // Simpan detail item diskon
      const { error: sdiErr } = await supabase
        .from("store_discount_items")
        .insert([
          {
            discount_id: storeDiscount.id,
            product_id: item.product_id,
            variant_id: item.variant_id || null,
            stock: item.stock,
            discount_percentage: item.discount_percentage,
          },
        ]);

      if (sdiErr) {
        console.error("Gagal simpan item diskon:", sdiErr.message);
      }
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

/* ===== CRON RESET STOK SETELAH BERAKHIR ===== */
cron.schedule("*/5 * * * *", async () => {
  const now = DateTime.utc().toISO();

  // Event selesai
  const { data: expiredEvents } = await supabase
    .from("events")
    .select("*")
    .lt("end_time", now);
  for (const ev of expiredEvents || []) {
    const { data: ep } = await supabase
      .from("event_products")
      .select("*")
      .eq("event_id", ev.id);
    for (const p of ep || []) {
      if (p.variant_id) {
        const { data: variant } = await supabase
          .from("product_variants")
          .select("*")
          .eq("id", p.variant_id)
          .single();
        if (variant) {
          await supabase
            .from("product_variants")
            .update({
              variant_stock: (variant.variant_stock || 0) + p.event_stock,
            })
            .eq("id", p.variant_id);
        }
      } else {
        const { data: product } = await supabase
          .from("products")
          .select("*")
          .eq("id", p.product_id)
          .single();
        if (product) {
          await supabase
            .from("products")
            .update({ stock: (product.stock || 0) + p.event_stock })
            .eq("id", p.product_id);
        }
      }
    }
    await supabase.from("event_products").delete().eq("event_id", ev.id);
  }

  // Flash sale selesai
  const { data: expiredFS } = await supabase
    .from("flash_sales")
    .select("*")
    .lt("end_time", now);
  for (const fs of expiredFS || []) {
    const { data: product } = await supabase
      .from("products")
      .select("*")
      .eq("id", fs.product_id)
      .single();
    if (product) {
      await supabase
        .from("products")
        .update({ stock: (product.stock || 0) + fs.flash_stock })
        .eq("id", fs.product_id);
    }
    await supabase.from("flash_sales").delete().eq("id", fs.id);
  }

  // Store discount selesai
  const { data: expiredStoreDiscounts } = await supabase
    .from("store_discounts")
    .select("*")
    .lt("end_time", now);
  for (const sd of expiredStoreDiscounts || []) {
    const { data: sdProducts } = await supabase
      .from("store_discount_products")
      .select("*")
      .eq("store_discount_id", sd.id);

    for (const sp of sdProducts || []) {
      if (sp.variant_id) {
        const { data: variant } = await supabase
          .from("product_variants")
          .select("*")
          .eq("id", sp.variant_id)
          .single();
        if (variant) {
          await supabase
            .from("product_variants")
            .update({ variant_stock: (variant.variant_stock || 0) + sp.stock })
            .eq("id", sp.variant_id);
        }
      } else {
        const { data: product } = await supabase
          .from("products")
          .select("*")
          .eq("id", sp.product_id)
          .single();
        if (product) {
          await supabase
            .from("products")
            .update({ stock: (product.stock || 0) + sp.stock })
            .eq("id", sp.product_id);
        }
      }
    }
    await supabase
      .from("store_discount_products")
      .delete()
      .eq("store_discount_id", sd.id);
    await supabase.from("store_discounts").delete().eq("id", sd.id);
  }
});

/* ===== EVENT GET BY ID (with discount detail) ===== */

/* ===== EVENT GET BY ID (with discount detail) ===== */
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

/* ===== STORE DISCOUNT BY SELLER (with discount detail) ===== */
router.get("/store-discount/seller/:seller_id", async (req, res) => {
  const { seller_id } = req.params;
  try {
    const { data: storeDiscounts, error } = await supabase
      .from("store_discounts")
      .select("*")
      .eq("store_id", seller_id);

    if (error) {
      return res.status(500).json({ message: "❌ Gagal ambil diskon toko" });
    }

    const discountsWithItems = [];
    for (const discount of storeDiscounts || []) {
      const { data: items = [] } = await supabase
        .from("store_discount_items")
        .select("products(*)")
        .eq("discount_id", discount.id);

      const products = (items || []).map((i) => i.products).filter(Boolean);
      const productsWithDiscount =
        products.length > 0 ? await attachVariantsStockDiscount(products) : [];

      discountsWithItems.push({ ...discount, items: productsWithDiscount });
    }

    return res.json({
      message: "✅ Diskon per toko berhasil diambil",
      data: discountsWithItems,
    });
  } catch (err) {
    res.status(500).json({ message: "❌ Error server", error: err.message });
  }
});

/* ===== FLASH SALE GET BY ID (with discount detail) ===== */
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

module.exports = router;
