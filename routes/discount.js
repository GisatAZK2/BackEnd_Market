const express = require("express");
const supabase = require("../config/supabase");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");

const router = express.Router();

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("❌ Hanya file gambar yang diizinkan"));
  },
});

// === Helper konversi ke WebP ===
async function convertToWebp(buffer) {
  return sharp(buffer).webp({ quality: 80 }).toBuffer();
}

// === Helper ambil varian & stok final + kalkulasi harga diskon ===
async function applyDiscountAndVariants(products, discountPercentage = 0) {
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
      finalPrice: p.price * (1 - discountPercentage / 100),
    }));
  }

  return products.map((p) => {
    const vList = variants.filter((v) => v.product_id === p.id);
    let finalStock = p.stock;
    if (vList.length > 0) {
      finalStock = vList.reduce((sum, v) => sum + v.variant_stock, 0);
    }
    return {
      ...p,
      variants: vList,
      finalStock,
      finalPrice: p.price * (1 - discountPercentage / 100),
    };
  });
}

// === Diskon per toko ===
router.post("/store", async (req, res) => {
  const { store_id, percentage, start_time, end_time, products } = req.body;
  if (!store_id || !percentage || !start_time || !end_time) {
    return res.status(400).json({ message: "❌ Semua field wajib diisi" });
  }

  const client = supabase; // alias
  try {
    // simpan diskon
    const { data: discount, error: discountErr } = await client
      .from("store_discounts")
      .insert([{ store_id, percentage, start_time, end_time }])
      .select()
      .single();
    if (discountErr)
      return res
        .status(500)
        .json({
          message: "❌ Gagal simpan diskon",
          error: discountErr.message,
        });

    // simpan detail produk/varian jika ada
    if (Array.isArray(products) && products.length > 0) {
      const items = [];
      products.forEach((p) => {
        if (Array.isArray(p.variant_ids) && p.variant_ids.length > 0) {
          p.variant_ids.forEach((vid) => {
            items.push({
              discount_id: discount.id,
              product_id: p.product_id,
              variant_id: vid,
            });
          });
        } else {
          items.push({ discount_id: discount.id, product_id: p.product_id });
        }
      });
      const { error: itemsErr } = await client
        .from("store_discount_items")
        .insert(items);
      if (itemsErr)
        return res
          .status(500)
          .json({
            message: "❌ Gagal simpan detail produk diskon",
            error: itemsErr.message,
          });
    }

    // Ambil produk terkait
    let productsQuery = client
      .from("products")
      .select("*")
      .eq("store_id", store_id);
    if (Array.isArray(products) && products.length > 0) {
      const ids = [...new Set(products.map((p) => p.product_id))];
      productsQuery = client.from("products").select("*").in("id", ids);
    }
    const { data: productsData } = await productsQuery;
    const productsWithDiscount = await applyDiscountAndVariants(
      productsData,
      percentage,
    );

    return res.json({
      message: "✅ Diskon toko berhasil ditambahkan",
      discount,
      products: productsWithDiscount,
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "❌ Error server", error: err.message });
  }
});

// === Event Global (flash sale umum / banner promo) ===
router.post("/event", upload.single("banner"), async (req, res) => {
  const { title, description, start_time, end_time } = req.body;
  if (!title || !start_time || !end_time) {
    return res
      .status(400)
      .json({ message: "❌ Field title, start_time, end_time wajib" });
  }

  try {
    let banner_url = null;

    if (req.file) {
      const fileName = `${uuidv4()}.webp`;
      const filePath = `events/${fileName}`;
      const webpBuffer = await convertToWebp(req.file.buffer);

      await supabase.storage
        .from("event-banners")
        .upload(filePath, webpBuffer, {
          contentType: "image/webp",
          upsert: true,
        });

      const { data } = supabase.storage
        .from("event-banners")
        .getPublicUrl(filePath);
      banner_url = data.publicUrl;
    }

    const { data, error } = await supabase
      .from("events")
      .insert([{ title, description, banner_url, start_time, end_time }])
      .select()
      .single();

    if (error)
      return res
        .status(500)
        .json({ message: "❌ Gagal simpan event", error: error.message });

    // event global -> semua produk kena efek?
    const { data: products } = await supabase.from("products").select("*");
    const productsWithDiscount = await applyDiscountAndVariants(products, 10); // contoh diskon global 10%

    return res.json({
      message: "✅ Event berhasil ditambahkan",
      data,
      products: productsWithDiscount,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "❌ Error server", error: err.message });
  }
});

// Ambil event aktif
router.get("/event/active", async (req, res) => {
  const now = new Date().toISOString();
  const { data: events, error } = await supabase
    .from("events")
    .select("*")
    .lte("start_time", now)
    .gte("end_time", now);

  if (error)
    return res
      .status(500)
      .json({ message: "❌ Gagal ambil event", error: error.message });

  const { data: products } = await supabase.from("products").select("*");
  const productsWithDiscount = await applyDiscountAndVariants(products, 10);

  return res.json({
    message: "✅ Event aktif",
    events,
    products: productsWithDiscount,
  });
});

// Flash Sale
router.post("/flash-sale/create", async (req, res) => {
  const { product_id, discount_percentage, flash_stock, start_time, end_time } =
    req.body;
  if (
    !product_id ||
    !discount_percentage ||
    !flash_stock ||
    !start_time ||
    !end_time
  ) {
    return res.status(400).json({ message: "❌ Semua field wajib diisi" });
  }

  try {
    const { data, error } = await supabase
      .from("flash_sales")
      .insert([
        { product_id, discount_percentage, flash_stock, start_time, end_time },
      ])
      .select()
      .single();

    if (error)
      return res
        .status(500)
        .json({ message: "❌ Gagal simpan flash sale", error: error.message });

    // ambil produk terkait
    const { data: product } = await supabase
      .from("products")
      .select("*")
      .eq("id", product_id)
      .single();
    const productsWithDiscount = await applyDiscountAndVariants(
      [product],
      discount_percentage,
    );

    return res.json({
      message: "✅ Flash sale berhasil ditambahkan",
      data,
      product: productsWithDiscount[0],
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "❌ Error server", error: err.message });
  }
});

// Ambil flash sale aktif
router.get("/flash-sale/active", async (req, res) => {
  const now = new Date().toISOString();
  const { data: flashSales, error } = await supabase
    .from("flash_sales")
    .select("*")
    .lte("start_time", now)
    .gte("end_time", now);

  if (error)
    return res
      .status(500)
      .json({ message: "❌ Gagal ambil flash sale", error: error.message });

  const productIds = flashSales.map((fs) => fs.product_id);
  const { data: products } = await supabase
    .from("products")
    .select("*")
    .in("id", productIds);

  // apply discount masing-masing
  const productsWithDiscount = await Promise.all(
    flashSales.map(async (fs) => {
      const p = products.find((pr) => pr.id === fs.product_id);
      const [final] = await applyDiscountAndVariants(
        [p],
        fs.discount_percentage,
      );
      return { ...final, flash_stock: fs.flash_stock };
    }),
  );

  return res.json({
    message: "✅ Flash sale aktif",
    flashSales,
    products: productsWithDiscount,
  });
});

module.exports = router;
