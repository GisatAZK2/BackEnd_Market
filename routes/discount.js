const express = require("express");
const supabase = require("../config/supabase");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const { DateTime } = require("luxon");
const cron = require("node-cron");
const {
  attachVariantsStockDiscount,
  attachVariantsStockDiscountWithRealDiscount,
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

/* ===== GET LIST FLASH SALE UNTUK CUSTOMER (PAKAI HELPER DISKON) ===== */
/* ===== GET LIST FLASH SALE UNTUK CUSTOMER (PAKAI HELPER DISKON) ===== */
router.get("/flash-sale-customer/list", async (req, res) => {
  try {
    // Ambil timezone dari device/browser (default ke Asia/Jakarta)
    const tz =
      req.query.timezone || req.headers["x-timezone"] || "Asia/Jakarta";

    // Ambil tanggal hari ini sesuai timezone device
    const now = DateTime.local().setZone(tz);
    const startDay = now.startOf("day").toISO(); // 00:00:00
    const endDay = now.endOf("day").toISO(); // 23:59:59

    // Ambil semua flash sale yang dimulai hari ini (abaikan kapan berakhir)
    const { data: flashSales, error } = await supabase
      .from("flash_sales")
      .select("*")
      .gte("start_time", startDay)
      .lt("start_time", endDay)
      .order("start_time", { ascending: true });

    if (error) {
      return res.status(500).json({
        message: "❌ Gagal mengambil daftar flash sale",
        error,
      });
    }

    if (!flashSales || flashSales.length === 0) {
      return res.json({
        message: `✅ Tidak ada flash sale untuk ${now.toISODate()}`,
        date: now.toISODate(),
        current_session: null,
        sessions: {
          morning: { label: "00:00 - 12:00", flash_sales: [] },
          afternoon: { label: "12:00 - 18:00", flash_sales: [] },
          evening: { label: "18:00 - 00:00", flash_sales: [] },
        },
      });
    }

    // Ambil daftar produk flash sale
    const { data: flashSaleProducts, error: fspErr } = await supabase
      .from("flash_sale_products")
      .select(
        `
        *,
        products (*),
        sellers (*),
        product_variants (*)
      `,
      )
      .in(
        "flash_sale_id",
        flashSales.map((fs) => fs.id),
      );

    if (fspErr) {
      return res.status(500).json({
        message: "❌ Gagal mengambil produk flash sale",
        error: fspErr,
      });
    }

    // Group produk per flash sale, satukan variannya
    const flashSaleProductsMap = {};
    for (const fsp of flashSaleProducts) {
      if (!flashSaleProductsMap[fsp.flash_sale_id]) {
        flashSaleProductsMap[fsp.flash_sale_id] = {};
      }

      const pid = fsp.products?.id;
      if (!pid) continue;

      // Kalau produk belum ada, buat dulu
      if (!flashSaleProductsMap[fsp.flash_sale_id][pid]) {
        flashSaleProductsMap[fsp.flash_sale_id][pid] = {
          ...fsp.products,
          seller: fsp.sellers,
          variants: [],
        };
      }

      // Masukkan variant (kalau ada)
      if (fsp.product_variants) {
        flashSaleProductsMap[fsp.flash_sale_id][pid].variants.push(
          fsp.product_variants,
        );
      }
    }

    // Convert hasil object jadi array per flash_sale_id
    for (const fsId in flashSaleProductsMap) {
      flashSaleProductsMap[fsId] = Object.values(flashSaleProductsMap[fsId]);
    }

    // Bagi ke dalam 3 sesi
    const sessions = {
      morning: { label: "00:00 - 12:00", flash_sales: [] },
      afternoon: { label: "12:00 - 18:00", flash_sales: [] },
      evening: { label: "18:00 - 00:00", flash_sales: [] },
    };

    for (const fs of flashSales) {
      const start = DateTime.fromISO(fs.start_time).setZone(tz);
      const end = DateTime.fromISO(fs.end_time).setZone(tz);
      const nowISO = DateTime.local().setZone(tz);

      // Status display
      let status = fs.status;
      if (fs.status === "active") {
        if (nowISO < start) status = "upcoming";
        else if (nowISO >= start && nowISO <= end) status = "ongoing";
        else status = "ended";
      }

      // Ambil produk & attach diskon
      const products = flashSaleProductsMap[fs.id] || [];
      const productsWithDiscount =
        products.length > 0
          ? await attachVariantsStockDiscountWithRealDiscount(products)
          : [];

      const flashSaleWithProducts = {
        ...fs,
        display_status: status,
        products: productsWithDiscount,
      };

      // Tentukan sesi berdasarkan jam mulai
      const startHour = start.hour;
      if (startHour >= 0 && startHour < 12) {
        sessions.morning.flash_sales.push(flashSaleWithProducts);
      } else if (startHour >= 12 && startHour < 18) {
        sessions.afternoon.flash_sales.push(flashSaleWithProducts);
      } else {
        sessions.evening.flash_sales.push(flashSaleWithProducts);
      }
    }

    // Tentukan sesi aktif sekarang
    const currentHour = now.hour;
    let currentSession = null;
    if (currentHour >= 0 && currentHour < 12) currentSession = "morning";
    else if (currentHour >= 12 && currentHour < 18)
      currentSession = "afternoon";
    else currentSession = "evening";

    return res.json({
      message: `✅ Flash sale untuk ${now.toISODate()} ditemukan`,
      date: now.toISODate(),
      current_session: currentSession,
      sessions,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server",
      error: err.message,
    });
  }
});

router.get("/flash-sale-customer/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const tz =
      req.query.timezone || req.headers["x-timezone"] || "Asia/Jakarta";

    // Ambil tanggal hari ini sesuai timezone (00:00 - 23:59)
    const now = DateTime.local().setZone(tz);
    const startDay = now.startOf("day");
    const endDay = now.endOf("day");

    // Ambil detail flash sale berdasarkan ID
    const { data: flashSale, error } = await supabase
      .from("flash_sales")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !flashSale) {
      return res.status(404).json({
        message: "❌ Flash sale tidak ditemukan",
        error,
      });
    }

    const flashSaleStart = DateTime.fromISO(flashSale.start_time).setZone(tz);
    const flashSaleEnd = DateTime.fromISO(flashSale.end_time).setZone(tz);

    // Pastikan flash sale ada overlap dengan hari ini (24 jam penuh)
    const isValidForToday =
      flashSaleStart < endDay && flashSaleEnd > startDay;

    if (!isValidForToday) {
      return res.status(404).json({
        message: "❌ Flash sale ini bukan untuk hari ini",
      });
    }

    // Ambil semua produk dalam flash sale ini
    const { data: flashSaleProducts, error: fspErr } = await supabase
      .from("flash_sale_products")
      .select(
        `
        *,
        products (*),
        sellers (*),
        product_variants (*)
      `
      )
      .eq("flash_sale_id", flashSale.id);

    if (fspErr) {
      return res.status(500).json({
        message: "❌ Gagal mengambil produk flash sale",
        error: fspErr,
      });
    }

    // Group produk agar varian tidak terpisah
    const groupedProducts = {};
    for (const fsp of flashSaleProducts) {
      const pid = fsp.products?.id;
      if (!pid) continue;

      if (!groupedProducts[pid]) {
        groupedProducts[pid] = {
          ...fsp.products,
          seller: fsp.sellers,
          variants: [],
          flash_sale_items: [],
        };
      }

      if (fsp.product_variants) {
        groupedProducts[pid].variants.push({
          ...fsp.product_variants,
          flash_sale_item_id: fsp.id, // ikat ke baris flash_sale_products
        });
      }

      groupedProducts[pid].flash_sale_items.push(fsp.id);
    }

    const products = Object.values(groupedProducts);

    // Tentukan status display
    let status = flashSale.status;
    if (flashSale.status === "active") {
      if (now < flashSaleStart) status = "upcoming";
      else if (now >= flashSaleStart && now <= flashSaleEnd) status = "ongoing";
      else status = "ended";
    }

    // Tentukan sesi berdasarkan jam mulai
    let session = null;
    const startHour = flashSaleStart.hour;
    if (startHour >= 0 && startHour < 12) session = "morning";
    else if (startHour >= 12 && startHour < 18) session = "afternoon";
    else session = "evening";

    // Attach diskon ke produk
    const productsWithDiscount =
      products.length > 0
        ? await attachVariantsStockDiscountWithRealDiscount(products)
        : [];

    const response = {
      ...flashSale,
      display_status: status,
      session,
      products: productsWithDiscount,
    };

    return res.json({
      message: "✅ Detail flash sale ditemukan",
      date: now.toISODate(),
      flash_sale: response,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server",
      error: err.message,
    });
  }
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
