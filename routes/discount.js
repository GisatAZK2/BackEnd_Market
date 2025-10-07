const express = require("express");
const supabase = require("../config/supabase");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const { DateTime } = require("luxon");
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
  const { title, description, start_time, end_time, timezone, categories, min_stock, min_discount } = req.body;

  // Validate required fields
  if (!title || !start_time || !end_time)
    return res
      .status(400)
      .json({ message: "❌ title, start_time, end_time wajib" });

  // Set default timezone if not provided
  const tz = timezone || "Asia/Jakarta";
  const startUTC = DateTime.fromISO(start_time, { zone: tz }).toUTC().toISO();
  const endUTC = DateTime.fromISO(end_time, { zone: tz }).toUTC().toISO();

  // Handle banner upload
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

  // Build the insert object with required and optional fields
  const insertData = {
    title,
    description,
    banner_url,
    start_time: startUTC,
    end_time: endUTC,
  };

  // Add optional fields if provided
  if (categories) insertData.categories = Array.isArray(categories) ? categories : [categories];
  if (min_stock) insertData.min_stock = parseInt(min_stock);
  if (min_discount) insertData.min_discount = parseFloat(min_discount);

  // Insert into database
  const { data, error } = await supabase
    .from("events")
    .insert([insertData])
    .select()
    .single();

  if (error)
    return res.status(500).json({ message: "❌ Gagal simpan event", error });
  res.json({ message: "✅ Event berhasil ditambahkan", data });
});

router.get("/event/list", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("events")
      .select("*")
      .order("start_time", { ascending: true });

    if (error) throw error;

    // Tambahin status event
    const now = DateTime.utc();
    const eventsWithStatus = data.map((event) => {
      const start = DateTime.fromISO(event.start_time);
      const end = DateTime.fromISO(event.end_time);

      let status = "upcoming";
      if (now >= start && now <= end) status = "active";
      if (now > end) status = "ended";

      return {
        ...event,
        status,
      };
    });

    res.json({
      message: "✅ Daftar event untuk customer",
      data: eventsWithStatus,
    });
  } catch (err) {
    res.status(500).json({ message: "❌ Gagal ambil event customer", error: err.message });
  }
});

router.get("/event/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;

    // 🔹 Ambil detail event
    const { data: event, error: evError } = await supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .single();

    if (evError) throw evError;
    if (!event) {
      return res.status(404).json({ message: "❌ Event tidak ditemukan" });
    }

    // 🔹 Ambil daftar produk dalam event
    const { data: eventProducts, error: epError } = await supabase
      .from("event_products")
      .select("product_id, event_stock, variant_id")
      .eq("event_id", eventId);

    if (epError) throw epError;
    if (!eventProducts?.length) {
      return res.json({
        message: "✅ Event ditemukan, tapi tidak ada produk",
        event: { ...event, rules: event.rules || null, products: [] },
      });
    }

    const productIds = [...new Set(eventProducts.map((ep) => ep.product_id))];

    // 🔹 Ambil produk + seller
    const { data: prodData, error: prodError } = await supabase
      .from("products")
      .select(`
        id,
        product_name,
        product_description,
        product_price,
        product_image_url,
        stock,
        min_price,
        max_price,
        terjual,
        created_at,
        category_id,
        keywords,
        seller:sellers (
          id,
          name,
          email,
          phone,
          store_name,
          store_address,
          store_image_url
        )
      `)
      .in("id", productIds);

    if (prodError) throw prodError;

    // 🔹 Enrich dengan varian, stok real & diskon
    let enrichedProducts = await attachVariantsStockDiscountWithRealDiscount(prodData);

    // 🔹 Filter hanya varian yang kena event
    const products = enrichedProducts.map((product) => {
      const eps = eventProducts.filter((e) => e.product_id === product.id);

      let eventVariants = [];
      if (product.variants && product.variants.length > 0) {
        eventVariants = product.variants
          .filter((v) => v.discount_source?.includes("event")) // cuma varian yg ada event discount
          .map((v) => {
            const ev = eps.find((e) => e.variant_id === v.id);
            return { ...v, event_stock: ev?.event_stock ?? null };
          });
      }

      return {
        ...product,
        variants: eventVariants,
      };
    }).filter((p) => p.variants.length > 0); // jangan tampilkan produk kalau ga ada varian event

    res.json({
      message: "✅ Detail event flash sale",
      event: {
        ...event,
        rules: event.rules || null,
        products: products,
      },
    });
  } catch (err) {
    console.error("❌ Gagal ambil detail event:", err);
    res.status(500).json({
      message: "❌ Gagal ambil detail event",
      error: err.message,
    });
  }
});

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
