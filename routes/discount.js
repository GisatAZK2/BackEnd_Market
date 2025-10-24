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

// ===== GET LIST FLASH SALE UNTUK CUSTOMER =====
router.get("/flash-sale-customer/list", async (req, res) => {
  try {
    // Ambil timezone dari device/browser (default ke Asia/Jakarta)
    const tz = req.query.timezone || req.headers["x-timezone"] || "Asia/Jakarta";

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

    if (error || !flashSales) {
      return res.status(500).json({
        message: "❌ Gagal mengambil daftar flash sale",
        error: error?.message || "Data flash sales tidak tersedia",
      });
    }

    if (flashSales.length === 0) {
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
      .select(`
        *,
        products (
          id,
          product_name,
          product_image_url,
          product_price,
          stock,
          terjual,
          ratings!left (
            rating
          )
        ),
        sellers (
          id,
          name,
          is_delivery_available,
          delivery_fee
        ),
        product_variants (
          id,
          variant_name,
          variant_price,
          variant_stock,
          variant_image_url
        )
      `)
      .in(
        "flash_sale_id",
        flashSales.map((fs) => fs.id),
      );

    if (fspErr || !flashSaleProducts) {
      return res.status(500).json({
        message: "❌ Gagal mengambil produk flash sale",
        error: fspErr?.message || "Data produk flash sale tidak tersedia",
      });
    }

    // Group produk per flash sale, pisahkan varian sebagai produk terpisah
    const flashSaleProductsMap = {};
    for (const fsp of flashSaleProducts) {
      if (!fsp || !fsp.flash_sale_id) continue;

      if (!flashSaleProductsMap[fsp.flash_sale_id]) {
        flashSaleProductsMap[fsp.flash_sale_id] = [];
      }

      const pid = fsp.products?.id;
      if (!pid) continue;

      // Hitung rata-rata rating
      let avgRating = null;
      let totalRatings = 0;
      if (fsp.products.ratings && fsp.products.ratings.length > 0) {
        const sum = fsp.products.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = Number((sum / fsp.products.ratings.length).toFixed(2));
        totalRatings = fsp.products.ratings.length;
      }

      // Jika ada varian, buat entri produk terpisah untuk setiap varian
      if (fsp.product_variants) {
        const variant = fsp.product_variants;
        flashSaleProductsMap[fsp.flash_sale_id].push({
          id: `${pid}-${variant.id}`, // ID produk + ID varian
          original_product_id: pid, // Simpan ID produk asli untuk diskon
          product_name: `${fsp.products.product_name} (${variant.variant_name || 'Default Variant'})`,
          product_image_url: variant.variant_image_url || fsp.products.product_image_url || [],
          product_price: variant.variant_price || fsp.products.product_price || 0,
          stock: variant.variant_stock || fsp.products.stock || 0,
          terjual: fsp.products.terjual || 0,
          avg_rating: avgRating,
          total_ratings: totalRatings,
          seller_name: fsp.sellers?.name || 'Unknown Seller',
          seller_id: fsp.sellers?.id || null,
          flash_sale_item_id: fsp.id,
          variant_id: variant.id, // Simpan variant_id untuk keperluan diskon
          is_delivery_available: fsp.sellers?.is_delivery_available || false,
          ...(fsp.sellers?.is_delivery_available && { delivery_fee: fsp.sellers?.delivery_fee }),
        });
      } else {
        // Jika tidak ada varian, gunakan produk utama
        flashSaleProductsMap[fsp.flash_sale_id].push({
          id: pid,
          original_product_id: pid,
          product_name: fsp.products.product_name,
          product_image_url: fsp.products.product_image_url || [],
          product_price: fsp.products.product_price || 0,
          stock: fsp.products.stock || 0,
          terjual: fsp.products.terjual || 0,
          avg_rating: avgRating,
          total_ratings: totalRatings,
          seller_name: fsp.sellers?.name || 'Unknown Seller',
          seller_id: fsp.sellers?.id || null,
          flash_sale_item_id: fsp.id,
          variant_id: null,
          is_delivery_available: fsp.sellers?.is_delivery_available || false,
          ...(fsp.sellers?.is_delivery_available && { delivery_fee: fsp.sellers?.delivery_fee }),
        });
      }
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
      let products = flashSaleProductsMap[fs.id] || [];
      const productsWithDiscount = products.length > 0
        ? await attachVariantsStockDiscountWithRealDiscount(products.map(p => ({
            ...p,
            id: p.original_product_id, // Gunakan original_product_id untuk diskon
            variants: [], // Kosongkan variants karena sudah dipisah
          })))
        : [];

      // Map products to ensure frontend-compatible structure and correct discount
      const formattedProducts = products.map(originalProduct => {
        const discountedProduct = productsWithDiscount.find(
          p => p.original_product_id === originalProduct.original_product_id
        );
        if (!discountedProduct) {
          return {
            id: originalProduct.id,
            product_name: originalProduct.product_name,
            product_image_url: Array.isArray(originalProduct.product_image_url)
              ? originalProduct.product_image_url
              : [originalProduct.product_image_url || ''],
            product_price: originalProduct.product_price || 0,
            finalPrice: originalProduct.product_price || 0,
            discountPercentage: 0,
            stock: Math.max(0, originalProduct.stock || 0),
            terjual: originalProduct.terjual || 0,
            avg_rating: originalProduct.avg_rating,
            total_ratings: originalProduct.total_ratings,
            seller_name: originalProduct.seller_name || 'Unknown Seller',
            seller_id: originalProduct.seller_id,
            is_delivery_available: originalProduct.is_delivery_available,
            ...(originalProduct.is_delivery_available && { delivery_fee: originalProduct.delivery_fee }),
            variants: [],
          };
        }

        // Jika produk adalah varian, ambil diskon dari variants di discountedProduct
        let discountPercentage = discountedProduct.discountPercentage || 0;
        let finalPrice = discountedProduct.finalPrice || discountedProduct.product_price || 0;
        let stock = Math.max(0, discountedProduct.finalStock || discountedProduct.stock || 0);

        if (originalProduct.variant_id && discountedProduct.variants && discountedProduct.variants.length > 0) {
          const variant = discountedProduct.variants.find(v => v.id === originalProduct.variant_id);
          if (variant) {
            discountPercentage = variant.applied_discount || 0;
            finalPrice = variant.final_price || originalProduct.product_price || 0;
            stock = Math.max(0, variant.variant_stock || originalProduct.stock || 0);
          }
        }

        return {
          id: originalProduct.id, // Gunakan ID asli (dengan varian)
          product_name: originalProduct.product_name,
          product_image_url: Array.isArray(originalProduct.product_image_url)
            ? originalProduct.product_image_url
            : [originalProduct.product_image_url || ''],
          product_price: originalProduct.product_price || 0,
          finalPrice: finalPrice,
          discountPercentage: discountPercentage,
          stock: stock,
          terjual: originalProduct.terjual || 0,
          avg_rating: originalProduct.avg_rating,
          total_ratings: originalProduct.total_ratings,
          seller_name: originalProduct.seller_name || 'Unknown Seller',
          seller_id: originalProduct.seller_id,
          is_delivery_available: originalProduct.is_delivery_available,
          ...(originalProduct.is_delivery_available && { delivery_fee: originalProduct.delivery_fee }),
          variants: [], // Kosong sesuai permintaan
        };
      });

      const flashSaleWithProducts = {
        ...fs,
        display_status: status,
        products: formattedProducts,
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
    else if (currentHour >= 12 && currentHour < 18) currentSession = "afternoon";
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

// ===== GET FLASH SALE BY ID FOR CUSTOMER =====
router.get("/flash-sale-customer/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const tz = req.query.timezone || req.headers["x-timezone"] || "Asia/Jakarta";

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
        error: error?.message || "Data flash sale tidak tersedia",
      });
    }

    const flashSaleStart = DateTime.fromISO(flashSale.start_time).setZone(tz);
    const flashSaleEnd = DateTime.fromISO(flashSale.end_time).setZone(tz);

    // Pastikan flash sale ada overlap dengan hari ini (24 jam penuh)
    const isValidForToday = flashSaleStart < endDay && flashSaleEnd > startDay;

    if (!isValidForToday) {
      return res.status(404).json({
        message: "❌ Flash sale ini bukan untuk hari ini",
      });
    }

    // Ambil semua produk dalam flash sale ini
    const { data: flashSaleProducts, error: fspErr } = await supabase
      .from("flash_sale_products")
      .select(`
        *,
        products (
          id,
          product_name,
          product_image_url,
          product_price,
          stock,
          terjual,
          ratings!left (
            rating
          )
        ),
        sellers (
          id,
          name,
          is_delivery_available,
          delivery_fee
        ),
        product_variants (
          id,
          variant_name,
          variant_price,
          variant_stock,
          variant_image_url
        )
      `)
      .eq("flash_sale_id", flashSale.id);

    if (fspErr || !flashSaleProducts) {
      return res.status(500).json({
        message: "❌ Gagal mengambil produk flash sale",
        error: fspErr?.message || "Data produk flash sale tidak tersedia",
      });
    }

    // Group produk, pisahkan varian sebagai produk terpisah
    const products = [];
    for (const fsp of flashSaleProducts) {
      if (!fsp || !fsp.products) continue;

      const pid = fsp.products.id;
      if (!pid) continue;

      // Hitung rata-rata rating
      let avgRating = null;
      let totalRatings = 0;
      if (fsp.products.ratings && fsp.products.ratings.length > 0) {
        const sum = fsp.products.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = Number((sum / fsp.products.ratings.length).toFixed(2));
        totalRatings = fsp.products.ratings.length;
      }

      // Jika ada varian, buat entri produk terpisah untuk varian
      if (fsp.product_variants) {
        const variant = fsp.product_variants;
        products.push({
          id: `${pid}-${variant.id}`, // ID produk + ID varian
          original_product_id: pid, // Simpan ID produk asli untuk diskon
          product_name: `${fsp.products.product_name} (${variant.variant_name || 'Default Variant'})`,
          product_image_url: variant.variant_image_url || fsp.products.product_image_url || [],
          product_price: variant.variant_price || fsp.products.product_price || 0,
          stock: variant.variant_stock || fsp.products.stock || 0,
          terjual: fsp.products.terjual || 0,
          avg_rating: avgRating,
          total_ratings: totalRatings,
          seller_name: fsp.sellers?.name || 'Unknown Seller',
          seller_id: fsp.sellers?.id || null,
          flash_sale_item_id: fsp.id,
          variant_id: variant.id, // Simpan variant_id untuk keperluan diskon
          is_delivery_available: fsp.sellers?.is_delivery_available || false,
          ...(fsp.sellers?.is_delivery_available && { delivery_fee: fsp.sellers?.delivery_fee }),
        });
      } else {
        // Jika tidak ada varian, gunakan produk utama
        products.push({
          id: pid,
          original_product_id: pid,
          product_name: fsp.products.product_name,
          product_image_url: fsp.products.product_image_url || [],
          product_price: fsp.products.product_price || 0,
          stock: fsp.products.stock || 0,
          terjual: fsp.products.terjual || 0,
          avg_rating: avgRating,
          total_ratings: totalRatings,
          seller_name: fsp.sellers?.name || 'Unknown Seller',
          seller_id: fsp.sellers?.id || null,
          flash_sale_item_id: fsp.id,
          variant_id: null,
          is_delivery_available: fsp.sellers?.is_delivery_available || false,
          ...(fsp.sellers?.is_delivery_available && { delivery_fee: fsp.sellers?.delivery_fee }),
        });
      }
    }

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
    const productsWithDiscount = products.length > 0
      ? await attachVariantsStockDiscountWithRealDiscount(products.map(p => ({
          ...p,
          id: p.original_product_id, // Gunakan original_product_id untuk diskon
          variants: [], // Kosongkan variants karena sudah dipisah
        })))
      : [];

    // Map products to ensure frontend-compatible structure and correct discount
    const formattedProducts = products.map(originalProduct => {
      const discountedProduct = productsWithDiscount.find(
        p => p.original_product_id === originalProduct.original_product_id
      );
      if (!discountedProduct) {
        return {
          id: originalProduct.id,
          product_name: originalProduct.product_name,
          product_image_url: Array.isArray(originalProduct.product_image_url)
            ? originalProduct.product_image_url
            : [originalProduct.product_image_url || ''],
          product_price: originalProduct.product_price || 0,
          finalPrice: originalProduct.product_price || 0,
          discountPercentage: 0,
          stock: Math.max(0, originalProduct.stock || 0),
          terjual: originalProduct.terjual || 0,
          avg_rating: originalProduct.avg_rating,
          total_ratings: originalProduct.total_ratings,
          seller_name: originalProduct.seller_name || 'Unknown Seller',
          seller_id: originalProduct.seller_id,
          is_delivery_available: originalProduct.is_delivery_available,
          ...(originalProduct.is_delivery_available && { delivery_fee: originalProduct.delivery_fee }),
          variants: [],
        };
      }

      // Jika produk adalah varian, ambil diskon dari variants di discountedProduct
      let discountPercentage = discountedProduct.discountPercentage || 0;
      let finalPrice = discountedProduct.finalPrice || discountedProduct.product_price || 0;
      let stock = Math.max(0, discountedProduct.finalStock || discountedProduct.stock || 0);

      if (originalProduct.variant_id && discountedProduct.variants && discountedProduct.variants.length > 0) {
        const variant = discountedProduct.variants.find(v => v.id === originalProduct.variant_id);
        if (variant) {
          discountPercentage = variant.applied_discount || 0;
          finalPrice = variant.final_price || originalProduct.product_price || 0;
          stock = Math.max(0, variant.variant_stock || originalProduct.stock || 0);
        }
      }

      return {
        id: originalProduct.id, // Gunakan ID asli (dengan varian)
        product_name: originalProduct.product_name,
        product_image_url: Array.isArray(originalProduct.product_image_url)
          ? originalProduct.product_image_url
          : [originalProduct.product_image_url || ''],
        product_price: originalProduct.product_price || 0,
        finalPrice: finalPrice,
        discountPercentage: discountPercentage,
        stock: stock,
        terjual: originalProduct.terjual || 0,
        avg_rating: originalProduct.avg_rating,
        total_ratings: originalProduct.total_ratings,
        seller_name: originalProduct.seller_name || 'Unknown Seller',
        seller_id: originalProduct.seller_id,
        is_delivery_available: originalProduct.is_delivery_available,
        ...(originalProduct.is_delivery_available && { delivery_fee: originalProduct.delivery_fee }),
        variants: [], // Kosong sesuai permintaan
      };
    });

    const response = {
      ...flashSale,
      display_status: status,
      session,
      products: formattedProducts,
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

// ===== FLASH SALE GET BY ID =====
router.get("/flash-sale/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const tz = req.query.timezone || req.headers["x-timezone"] || "Asia/Jakarta";

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
        error: error?.message || "Data flash sale tidak tersedia",
      });
    }

    const flashSaleStart = DateTime.fromISO(flashSale.start_time).setZone(tz);
    const flashSaleEnd = DateTime.fromISO(flashSale.end_time).setZone(tz);

    // Pastikan flash sale ada overlap dengan hari ini (24 jam penuh)
    const isValidForToday = flashSaleStart < endDay && flashSaleEnd > startDay;

    if (!isValidForToday) {
      return res.status(404).json({
        message: "❌ Flash sale ini bukan untuk hari ini",
      });
    }

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

    // Ambil detail produk
    const { data: product, error: productError } = await supabase
      .from("products")
      .select(`
        id,
        product_name,
        product_image_url,
        product_price,
        stock,
        terjual,
        ratings!left (
          rating
        ),
        sellers (
          id,
          name,
          is_delivery_available,
          delivery_fee
        ),
        product_variants (
          id,
          variant_name,
          variant_price,
          variant_stock,
          variant_image_url
        )
      `)
      .eq("id", flashSale.product_id)
      .single();

    if (productError || !product) {
      return res.status(500).json({
        message: "❌ Gagal mengambil produk flash sale",
        error: productError?.message || "Data produk tidak tersedia",
      });
    }

    // Hitung rata-rata rating
    let avgRating = null;
    let totalRatings = 0;
    if (product.ratings && product.ratings.length > 0) {
      const sum = product.ratings.reduce((acc, r) => acc + r.rating, 0);
      avgRating = Number((sum / product.ratings.length).toFixed(2));
      totalRatings = product.ratings.length;
    }

    // Pisahkan varian sebagai produk terpisah
    const products = [];
    if (product.product_variants && product.product_variants.length > 0) {
      product.product_variants.forEach(variant => {
        products.push({
          id: `${product.id}-${variant.id}`, // ID produk + ID varian
          original_product_id: product.id, // Simpan ID produk asli untuk diskon
          product_name: `${product.product_name} (${variant.variant_name || 'Default Variant'})`,
          product_image_url: variant.variant_image_url || product.product_image_url || [],
          product_price: variant.variant_price || product.product_price || 0,
          stock: variant.variant_stock || product.stock || 0,
          terjual: product.terjual || 0,
          avg_rating: avgRating,
          total_ratings: totalRatings,
          seller_name: product.sellers?.name || 'Unknown Seller',
          seller_id: product.sellers?.id || null,
          variant_id: variant.id, // Simpan variant_id untuk keperluan diskon
          is_delivery_available: product.sellers?.is_delivery_available || false,
          ...(product.sellers?.is_delivery_available && { delivery_fee: product.sellers?.delivery_fee }),
        });
      });
    } else {
      products.push({
        id: product.id,
        original_product_id: product.id,
        product_name: product.product_name,
        product_image_url: product.product_image_url || [],
        product_price: product.product_price || 0,
        stock: product.stock || 0,
        terjual: product.terjual || 0,
        avg_rating: avgRating,
        total_ratings: totalRatings,
        seller_name: product.sellers?.name || 'Unknown Seller',
        seller_id: product.sellers?.id || null,
        variant_id: null,
        is_delivery_available: product.sellers?.is_delivery_available || false,
        ...(product.sellers?.is_delivery_available && { delivery_fee: product.sellers?.delivery_fee }),
      });
    }

    // Attach diskon ke produk
    const productsWithDiscount = products.length > 0
      ? await attachVariantsStockDiscountWithRealDiscount(products.map(p => ({
          ...p,
          id: p.original_product_id, // Gunakan original_product_id untuk diskon
          variants: [], // Kosongkan variants karena sudah dipisah
        })))
      : [];

    // Map products to ensure frontend-compatible structure and correct discount
    const formattedProduct = products.map(originalProduct => {
      const discountedProduct = productsWithDiscount.find(
        p => p.original_product_id === originalProduct.original_product_id
      );
      if (!discountedProduct) {
        return {
          id: originalProduct.id,
          product_name: originalProduct.product_name,
          product_image_url: Array.isArray(originalProduct.product_image_url)
            ? originalProduct.product_image_url
            : [originalProduct.product_image_url || ''],
          product_price: originalProduct.product_price || 0,
          finalPrice: originalProduct.product_price || 0,
          discountPercentage: 0,
          stock: Math.max(0, originalProduct.stock || 0),
          terjual: originalProduct.terjual || 0,
          avg_rating: originalProduct.avg_rating,
          total_ratings: originalProduct.total_ratings,
          seller_name: originalProduct.seller_name || 'Unknown Seller',
          seller_id: originalProduct.seller_id,
          is_delivery_available: originalProduct.is_delivery_available,
          ...(originalProduct.is_delivery_available && { delivery_fee: originalProduct.delivery_fee }),
          variants: [],
        };
      }

      // Jika produk adalah varian, ambil diskon dari variants di discountedProduct
      let discountPercentage = discountedProduct.discountPercentage || 0;
      let finalPrice = discountedProduct.finalPrice || discountedProduct.product_price || 0;
      let stock = Math.max(0, discountedProduct.finalStock || discountedProduct.stock || 0);

      if (originalProduct.variant_id && discountedProduct.variants && discountedProduct.variants.length > 0) {
        const variant = discountedProduct.variants.find(v => v.id === originalProduct.variant_id);
        if (variant) {
          discountPercentage = variant.applied_discount || 0;
          finalPrice = variant.final_price || originalProduct.product_price || 0;
          stock = Math.max(0, variant.variant_stock || originalProduct.stock || 0);
        }
      }

      return {
        id: originalProduct.id, // Gunakan ID asli (dengan varian)
        product_name: originalProduct.product_name,
        product_image_url: Array.isArray(originalProduct.product_image_url)
          ? originalProduct.product_image_url
          : [originalProduct.product_image_url || ''],
        product_price: originalProduct.product_price || 0,
        finalPrice: finalPrice,
        discountPercentage: discountPercentage,
        stock: stock,
        terjual: originalProduct.terjual || 0,
        avg_rating: originalProduct.avg_rating,
        total_ratings: originalProduct.total_ratings,
        seller_name: originalProduct.seller_name || 'Unknown Seller',
        seller_id: originalProduct.seller_id,
        is_delivery_available: originalProduct.is_delivery_available,
        ...(originalProduct.is_delivery_available && { delivery_fee: originalProduct.delivery_fee }),
        variants: [], // Kosong sesuai permintaan
      };
    })[0] || null;

    const response = {
      ...flashSale,
      display_status: status,
      session,
      product: formattedProduct,
    };

    return res.json({
      message: "✅ Detail flash sale",
      date: now.toISODate(),
      flash_sale: response,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "❌ Error server",
      error: err.message,
    });
  }
});

module.exports = router;
