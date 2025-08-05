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

/* ===== SELLER REGISTER PRODUK KE FLASH SALE ===== */
router.post("/flash-sale/register", async (req, res) => {
  const { seller_id, flash_sale_id, products } = req.body;
  if (
    !seller_id ||
    !flash_sale_id ||
    !Array.isArray(products) ||
    !products.length
  ) {
    return res
      .status(400)
      .json({ message: "❌ seller_id, flash_sale_id & products wajib" });
  }

  // Pastikan flash sale ada
  const { data: flashSale } = await supabase
    .from("flash_sales")
    .select("*")
    .eq("id", flash_sale_id)
    .single();
  if (!flashSale)
    return res.status(404).json({ message: "❌ Flash sale tidak ditemukan" });

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
        .update({ variant_stock: (variant.variant_stock || 0) - p.flash_stock })
        .eq("id", p.variant_id);

      rows.push({
        seller_id,
        flash_sale_id,
        product_id: p.product_id,
        variant_id: p.variant_id,
        flash_stock: p.flash_stock,
        discount_percentage: flashSale.discount_percentage,
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
        flash_sale_id,
        product_id: p.product_id,
        variant_id: null,
        flash_stock: p.flash_stock,
        discount_percentage: flashSale.discount_percentage,
      });
    }
  }

  const { error } = await supabase.from("flash_sale_products").insert(rows);
  if (error) {
    return res
      .status(500)
      .json({ message: "❌ Gagal daftar produk ke flash sale", error });
  }

  res.json({ message: "✅ Produk berhasil didaftarkan ke flash sale" });
});

/* ===== STORE DISCOUNT CREATE ===== */
router.post("/store-discount/create", async (req, res) => {
  const { store_id, name, start_time, end_time, timezone, items } = req.body;

  if (!store_id || !name || !items?.length || !start_time || !end_time) {
    return res.status(400).json({
      message: "❌ store_id, name, start_time, end_time & items wajib diisi",
    });
  }

  const tz = timezone || "Asia/Jakarta";
  const startUTC = DateTime.fromISO(start_time, { zone: tz }).toUTC().toISO();
  const endUTC = DateTime.fromISO(end_time, { zone: tz }).toUTC().toISO();

  try {
    const { data: storeDiscount, error: sdErr } = await supabase
      .from("store_discounts")
      .insert([{ store_id, name, start_time: startUTC, end_time: endUTC }])
      .select()
      .single();

    if (sdErr) {
      return res.status(500).json({
        message: "❌ Gagal simpan diskon toko",
        error: sdErr.message,
      });
    }

    for (const item of items) {
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

/* ===== CRON RESET STOK & NONAKTIFKAN FLASH SALE YANG HABIS ===== */
cron.schedule("0 * * * *", async () => {
  const now = DateTime.utc().toISO();

  // Ambil sesi flash sale yang sudah habis
  const { data: expiredSessions, error: expiredErr } = await supabase
    .from("flash_sales")
    .select("id")
    .lt("end_time", now)
    .eq("status", "active");

  if (expiredErr) {
    console.error("❌ Gagal ambil sesi flash sale:", expiredErr);
    return;
  }
  if (!expiredSessions?.length) return;

  const expiredIds = expiredSessions.map((s) => s.id);

  // Ambil semua produk yang ikut sesi
  const { data: saleProducts } = await supabase
    .from("flash_sale_products")
    .select("product_id,variant_id,flash_stock,discount_percentage")
    .in("flash_sale_id", expiredIds);

  for (const sp of saleProducts) {
    if (sp.variant_id) {
      const { data: variant } = await supabase
        .from("product_variants")
        .select("variant_stock, variant_price")
        .eq("id", sp.variant_id)
        .single();
      if (variant) {
        await supabase
          .from("product_variants")
          .update({
            variant_stock: (variant.variant_stock || 0) + sp.flash_stock,
            variant_price:
              variant.variant_price / (1 - sp.discount_percentage / 100),
          })
          .eq("id", sp.variant_id);
      }
    } else {
      const { data: product } = await supabase
        .from("products")
        .select("stock, product_price")
        .eq("id", sp.product_id)
        .single();
      if (product) {
        await supabase
          .from("products")
          .update({
            stock: (product.stock || 0) + sp.flash_stock,
            product_price:
              product.product_price / (1 - sp.discount_percentage / 100),
          })
          .eq("id", sp.product_id);
      }
    }
  }

  // Update status sesi ke disabled
  await supabase
    .from("flash_sales")
    .update({ status: "disabled" })
    .in("id", expiredIds);

  console.log(
    `🔄 Reset ${saleProducts.length} produk & nonaktifkan ${expiredIds.length} sesi flash sale`,
  );
});

/* ===== GENERATE FLASH SALE SESSION TIAP HARI ===== */
async function generateSessionsForToday() {
  const today = DateTime.now().setZone("Asia/Jakarta");
  const isSpecialDate = today.day === today.month;

  const sessions = isSpecialDate
    ? [
        { start: "00:00", end: "04:00" },
        { start: "04:00", end: "08:00" },
        { start: "08:00", end: "12:00" },
        { start: "12:00", end: "16:00" },
        { start: "16:00", end: "20:00" },
        { start: "20:00", end: "00:00" },
      ]
    : [
        { start: "00:00", end: "12:00" },
        { start: "12:00", end: "18:00" },
        { start: "18:00", end: "00:00" },
      ];

  for (const s of sessions) {
    const startTime = today.set({
      hour: parseInt(s.start.split(":")[0]),
      minute: parseInt(s.start.split(":")[1]),
    });
    let endTime = today.set({
      hour: parseInt(s.end.split(":")[0]),
      minute: parseInt(s.end.split(":")[1]),
    });
    if (s.end === "00:00") endTime = endTime.plus({ days: 1 });

    // Buat sesi baru
    const { data: newSession, error } = await supabase
      .from("flash_sales")
      .insert([
        {
          start_time: startTime.toUTC().toISO(),
          end_time: endTime.toUTC().toISO(),
          status: "active",
        },
      ])
      .select()
      .single();
    if (error) console.error("❌ Gagal buat sesi:", error);

    if (newSession) {
      // Masukin produk default (kalau mau auto generate)
      await supabase.from("flash_sale_products").insert([
        {
          flash_sale_id: newSession.id,
          product_id: 123,
          discount_percentage: 20,
          flash_stock: 50,
        },
      ]);
    }
  }
}

/* ===== CRON GENERATE SESSION BARU ===== */
cron.schedule("0 0 * * *", async () => {
  // Cek sesi aktif
  const { data: sessions } = await supabase
    .from("flash_sales")
    .select("id")
    .gte("end_time", DateTime.utc().toISO());

  if (!sessions?.length) {
    console.log(
      "⚡ Tidak ada sesi flash sale aktif → generate otomatis 1 bulan",
    );
    for (let i = 0; i < 30; i++) {
      const targetDay = DateTime.now()
        .setZone("Asia/Jakarta")
        .plus({ days: i });
      await generateSessionsForToday(targetDay);
    }
  }
});

/* ===== EVENT GET BY ID ===== */
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

/* ===== STORE DISCOUNT BY SELLER ===== */
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

module.exports = router;
