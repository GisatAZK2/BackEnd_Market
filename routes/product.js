const express = require("express");
const path = require("path");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const sharp = require("sharp");
const supabase = require("../config/supabase");
const generateKeywords = require("../utils/keywordGenerator");
const {
  applyDiscount,
  getActiveDiscountForProduct,
  attachVariantsStockDiscountWithRealDiscount,
} = require("../utils/applyDiscountAndVariants");
const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 10 });

const router = express.Router();

// === Multer tanpa filter format ketat (cek mimetype basic) ===
const uploadMulter = multer({
  limits: { fileSize: 10 * 1024 * 1024 }, // naikkan limit jadi 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("❌ Hanya file gambar yang diizinkan"));
  },
});

const uploadForCreate = uploadMulter.fields([
  { name: "productImages", maxCount: 10 },
  { name: "variantImages", maxCount: 10 },
]);

const uploadForEdit = uploadMulter.fields([
  { name: "productImages", maxCount: 10 },
  { name: "variantImages", maxCount: 10 },
]);

async function convertToWebp(buffer) {
  return sharp(buffer).webp({ quality: 80 }).toBuffer();
}

// === Upload Produk Baru ===
router.post("/upload", uploadForCreate, async (req, res) => {
  const {
    seller_id,
    productName,
    productDescription,
    category_id,
    stock,
    variants,
    productPrice,
  } = req.body;

  if (!seller_id || !productName || !productDescription || !category_id) {
    return res.status(400).json({ message: "❌ Semua field wajib diisi" });
  }

  if (!req.files["productImages"]) {
    return res
      .status(400)
      .json({ message: "❌ Minimal 1 gambar produk diperlukan" });
  }

  try {
    const { data: seller } = await supabase
      .from("sellers")
      .select("*")
      .eq("id", seller_id)
      .single();

    if (!seller)
      return res.status(404).json({ message: "❌ Seller tidak ditemukan" });

    const productImagesUrls = [];
    for (let img of req.files["productImages"]) {
      const fileName = `${uuidv4()}.webp`;
      const filePath = `${seller_id}/products/${fileName}`;

      const webpBuffer = await convertToWebp(img.buffer);

      await supabase.storage
        .from("product-images")
        .upload(filePath, webpBuffer, {
          contentType: "image/webp",
          upsert: true,
        });

      const { data } = supabase.storage
        .from("product-images")
        .getPublicUrl(filePath);

      productImagesUrls.push(data.publicUrl);
    }

    const imageField =
      productImagesUrls.length === 1 ? productImagesUrls[0] : productImagesUrls;

    const keywords = [
      ...generateKeywords(productName),
      ...generateKeywords(productDescription),
    ];

    let parsedVariants = [];
    try {
      if (variants) parsedVariants = JSON.parse(variants);
    } catch {
      return res.status(400).json({ message: "❌ Format varian tidak valid" });
    }

    let uploadedVariants = [];
    let totalStock = stock ? parseInt(stock) : 0;
    let finalProductPrice = 0,
      minPrice = 0,
      maxPrice = 0;

    if (Array.isArray(parsedVariants) && parsedVariants.length > 0) {
      for (let i = 0; i < parsedVariants.length; i++) {
        const v = parsedVariants[i];
        let variantImageUrl = v.image_url || null;

        if (req.files["variantImages"] && req.files["variantImages"][i]) {
          const fileName = `${uuidv4()}.webp`;
          const variantPath = `${seller_id}/variants/${fileName}`;
          const webpVariant = await convertToWebp(
            req.files["variantImages"][i].buffer,
          );

          await supabase.storage
            .from("product-images")
            .upload(variantPath, webpVariant, {
              contentType: "image/webp",
              upsert: true,
            });

          const { data } = supabase.storage
            .from("product-images")
            .getPublicUrl(variantPath);
          variantImageUrl = data.publicUrl;
        }

        uploadedVariants.push({
          product_id: null,
          variant_name: v.name,
          variant_price: parseFloat(v.price),
          variant_stock: parseInt(v.stock),
          variant_image_url: variantImageUrl,
        });
      }

      const prices = uploadedVariants.map((v) => v.variant_price);
      minPrice = Math.min(...prices);
      maxPrice = Math.max(...prices);
      finalProductPrice = minPrice;
      totalStock = uploadedVariants.reduce(
        (sum, v) => sum + v.variant_stock,
        0,
      );
    } else {
      const parsedPrice = parseFloat(productPrice);
      if (isNaN(parsedPrice) || parsedPrice <= 0)
        return res.status(400).json({
          message: "❌ Produk tanpa varian harus memiliki harga lebih dari 0",
        });
      finalProductPrice = parsedPrice;
      minPrice = parsedPrice;
      maxPrice = parsedPrice;
    }

    const { data: product, error: insertError } = await supabase
      .from("products")
      .insert([
        {
          seller_id,
          category_id,
          seller_name: seller.name,
          seller_email: seller.email,
          product_name: productName,
          product_description: productDescription,
          product_price: finalProductPrice,
          min_price: minPrice,
          max_price: maxPrice,
          stock: totalStock,
          product_image_url: imageField,
          keywords,
        },
      ])
      .select()
      .single();

    if (insertError)
      return res.status(500).json({
        message: "❌ Gagal insert produk",
        error: insertError.message,
      });

    if (uploadedVariants.length > 0) {
      for (let v of uploadedVariants) v.product_id = product.id;
      await supabase.from("product_variants").insert(uploadedVariants);
    }

    return res.status(201).json({
      message: "✅ Produk berhasil diunggah",
      data: { ...product, variants: uploadedVariants },
    });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "❌ Terjadi error", error: error.message });
  }
});

// === GET NEARBY ===
const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Nearby produk berdasarkan lokasi
router.get("/nearby-by-location", async (req, res) => {
  const { lat, lng } = req.query;
  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  if (isNaN(userLat) || isNaN(userLng)) {
    return res.status(400).json({ message: "❌ Koordinat tidak valid" });
  }

  try {
    const { data: sellers, error: sellerErr } = await supabase
      .from("sellers")
      .select("id, name, latitude, longitude");

    if (sellerErr) throw sellerErr;

    const { data: products, error: prodErr } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        )
      `);

    if (prodErr) throw prodErr;

    // Gabungkan dengan data seller + hitung jarak
    const merged = products
      .map((product) => {
        const seller = sellers.find((s) => s.id === product.seller_id);
        const distanceInKm =
          seller && seller.latitude && seller.longitude
            ? haversineDistance(
                userLat,
                userLng,
                seller.latitude,
                seller.longitude
              )
            : Infinity;

        // Hitung avg rating
        let avgRating = null;
        if (product.ratings && product.ratings.length > 0) {
          const sum = product.ratings.reduce((acc, r) => acc + r.rating, 0);
          avgRating = sum / product.ratings.length;
        }

        return {
          ...product,
          sellerName: seller?.name,
          distanceInKm: +distanceInKm.toFixed(2),
          avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
          total_ratings: product.ratings ? product.ratings.length : 0,
        };
      })
      .filter((p) => p.distanceInKm <= 40);

    // Tambahin varian + stok + diskon
    const mergedWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(merged);

    return res.status(200).json({
      message: `✅ Ditemukan ${mergedWithVariants.length} produk dalam radius 40 km`,
      products: mergedWithVariants,
    });
  } catch (error) {
    console.error("❌ Error nearby:", error);
    return res
      .status(500)
      .json({ message: "❌ Gagal mengambil produk nearby", error: error.message });
  }
});


// Produk terlaris (berdasarkan jumlah order)
// Produk terlaris (berdasarkan field "terjual" di tabel products)
router.get("/terlaris", async (req, res) => {
  try {
    // Ambil produk + rating
    const { data: products, error } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        )
      `);

    if (error) throw error;

    // Proses data -> tambahin avg rating + total terjual
    const processed = products.map((p) => {
      // Hitung rating
      let avgRating = null;
      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }

      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
        total_terjual: p.terjual ?? 0, // pake field "terjual"
      };
    });

    // Urutkan produk terlaris (paling banyak terjual)
    const sorted = processed.sort((a, b) => b.total_terjual - a.total_terjual);

    // Attach varian + stok + diskon
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(sorted);

    return res.status(200).json({
      message: `🔥 ${productsWithVariants.length} produk terlaris`,
      products: productsWithVariants,
    });
  } catch (error) {
    console.error("❌ Error terlaris:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil produk terlaris",
      error: error.message,
    });
  }
});


router.get("/allproduct", async (req, res) => {
  try {
    // Ambil semua produk + rata-rata rating
    const { data: products, error } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        )
      `);

    if (error) throw error;

    // Hitung rata-rata rating per produk
    const productsWithExtras = products.map((p) => {
      let avgRating = null;

      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }

      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
      };
    });

    // Attach varian + stock + diskon (fungsi custom-mu)
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(productsWithExtras);

    return res.status(200).json({
      message: `✅ ${products.length} produk`,
      products: productsWithVariants,
    });
  } catch (error) {
    console.error("❌ Gagal ambil produk:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil semua produk",
      error: error.message,
    });
  }
});
// Produk dengan urutan diskon terbesar
router.get("/sorted", async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        )
      `);

    if (error) throw error;

    // Hitung avg rating + total rating
    const productsWithExtras = products.map((p) => {
      let avgRating = null;

      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }

      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
      };
    });

    // Attach varian + stok + diskon
    let productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(productsWithExtras);

    // Urutkan berdasarkan diskon terbesar
    productsWithVariants = productsWithVariants.sort(
      (a, b) => b.discountPercentage - a.discountPercentage
    );

    return res.status(200).json({
      message: `✅ ${productsWithVariants.length} produk (urut diskon terbesar)`,
      products: productsWithVariants,
    });
  } catch (error) {
    console.error("❌ Error sorted:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil semua produk",
      error: error.message,
    });
  }
});

router.get("/trending", async (req, res) => {
  try {
    // 1. Ambil semua kategori
    const { data: categories, error: catErr } = await supabase
      .from("categories")
      .select("id, name");

    if (catErr) throw catErr;
    if (!categories || categories.length === 0) {
      return res.status(404).json({ message: "❌ Tidak ada kategori tersedia" });
    }

    // 2. Ambil semua produk dengan rating
    const { data: products, error: prodErr } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        )
      `);

    if (prodErr) throw prodErr;
    if (!products || products.length === 0) {
      return res.status(404).json({ message: "❌ Tidak ada produk tersedia" });
    }

    // 3. Hitung avg rating & total rating
    const productsWithExtras = products.map((p) => {
      let avgRating = null;
      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }
      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
      };
    });

    // 4. Pilih kategori trending (misalnya random)
    const randomCategory =
      categories[Math.floor(Math.random() * categories.length)];

    // Bagi produk berdasarkan kategori
    const fromCategory = productsWithExtras.filter(
      (p) => p.category_id === randomCategory.id
    );
    const otherProducts = productsWithExtras.filter(
      (p) => p.category_id !== randomCategory.id
    );

    // 5. Hitung jumlah produk trending 60% / 40%
    const totalTrending = Math.min(20, productsWithExtras.length); // ambil max 20 produk trending
    const catCount = Math.ceil(totalTrending * 0.6);
    const otherCount = totalTrending - catCount;

    // Ambil sample random dari masing-masing kelompok
    const pickRandom = (arr, count) =>
      arr.sort(() => 0.5 - Math.random()).slice(0, count);

    const selectedFromCategory = pickRandom(fromCategory, catCount);
    const selectedFromOthers = pickRandom(otherProducts, otherCount);

    let trendingProducts = [...selectedFromCategory, ...selectedFromOthers];

    // 6. Attach varian + stok + diskon
    trendingProducts = await attachVariantsStockDiscountWithRealDiscount(
      trendingProducts
    );

    // 7. Acak lagi biar lebih fresh
    trendingProducts.sort(() => 0.5 - Math.random());

    return res.status(200).json({
      message: `🔥 Trending produk dari kategori "${randomCategory.name}" (60%) + kategori lain (40%)`,
      total: trendingProducts.length,
      main_category: randomCategory.name,
      products: trendingProducts,
    });
  } catch (error) {
    console.error("❌ Error trending:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil trending produk",
      error: error.message,
    });
  }
});


// === Ambil produk berdasarkan kategori ===
// Produk berdasarkan kategori
router.get("/by-category/:category_id", async (req, res) => {
  const { category_id } = req.params;
  try {
    // Cek kategori
    const { data: category, error: catErr } = await supabase
      .from("categories")
      .select("id, name")
      .eq("id", category_id)
      .single();

    if (catErr) throw catErr;
    if (!category)
      return res.status(404).json({ message: "❌ Kategori tidak ditemukan" });

    // Ambil produk + rating
    const { data: products, error: prodErr } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        )
      `)
      .eq("category_id", category_id);

    if (prodErr) throw prodErr;

    // Hitung avg rating + total rating
    const productsWithExtras = products.map((p) => {
      let avgRating = null;
      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }
      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
      };
    });

    // Attach varian + stok + diskon
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(productsWithExtras);

    return res.status(200).json({
      message: `✅ Ditemukan ${products.length} produk dalam kategori "${category.name}"`,
      category: category.name,
      products: productsWithVariants,
    });
  } catch (error) {
    console.error("❌ Error by-category:", error);
    return res.status(500).json({
      message: "❌ Server error",
      error: error.message,
    });
  }
});


// Produk terkait (suggestions)

router.get("/:id", async (req, res) => {
  const { id } = req.params;

  // Cek cache
  const cached = cache.get(`product_${id}`);
  if (cached) {
    return res
      .status(200)
      .json({ message: "✅ Produk ditemukan (cache)", product: cached });
  }

  try {
    const { data: product, error } = await supabase
      .from("products")
      .select(
        `
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
      `,
      )
      .eq("id", id)
      .single();

    if (error || !product) {
      return res.status(404).json({ message: "❌ Produk tidak ditemukan" });
    }

    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount([product]);
    const result = { ...productsWithVariants[0], seller: product.seller };

    cache.set(`product_${id}`, result);
    return res
      .status(200)
      .json({ message: "✅ Produk ditemukan", product: result });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "❌ Gagal mengambil produk", error: err.message });
  }
});

router.get("/:productId/ratings", async (req, res) => {
  try {
    const { productId } = req.params;

    const { data: ratings, error } = await supabase
      .from("ratings")
      .select(
        `
        id,
        rating,
        review_text,
        review_images,
        created_at,
        user_id,
        users ( id, username, avatar ),
        rating_replies (
          id,
          reply_text,
          created_at,
          seller_id,
          sellers ( id, store_name, store_image_url )
        )
        `
      )
      .eq("product_id", productId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ message: "❌ Gagal ambil rating produk." });
    }

    if (!ratings || ratings.length === 0) {
      return res.status(200).json({
        message: "⚠️ Produk ini belum punya rating.",
        average_rating: 0,
        total_reviews: 0,
        ratings: [],
      });
    }

    const total = ratings.reduce((sum, r) => sum + r.rating, 0);
    const avg = total / ratings.length;

    return res.status(200).json({
      message: "✅ Rating produk berhasil diambil.",
      average_rating: Number(avg.toFixed(2)),
      total_reviews: ratings.length,
      ratings,
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});


// == Ambil Produk Berdasarkan Sugesti Produk name
router.get("/:id/suggestions", async (req, res) => {
  const { id } = req.params;
  try {
    // Ambil produk utama + rating
    const { data: product, error: prodErr } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        )
      `)
      .eq("id", id)
      .single();

    if (prodErr) throw prodErr;
    if (!product) {
      return res.status(404).json({ message: "❌ Produk tidak ditemukan" });
    }

    // Hitung avg rating produk utama
    let avgRating = null;
    if (product.ratings && product.ratings.length > 0) {
      const sum = product.ratings.reduce((acc, r) => acc + r.rating, 0);
      avgRating = sum / product.ratings.length;
    }
    const baseProduct = {
      id: product.id,
      name: product.product_name,
      avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
      total_ratings: product.ratings ? product.ratings.length : 0,
    };

    if (!product.product_name) {
      return res.status(400).json({
        message:
          "❌ Produk tidak punya field product_name untuk pencarian terkait",
      });
    }

    // Buat keyword dari nama produk
    const keywords = product.product_name
      .split(" ")
      .filter((w) => w.length > 2);

    if (!keywords.length) {
      return res.status(200).json({
        message: "✅ Tidak ada keyword relevan untuk produk terkait",
        base_product: baseProduct,
        suggestions: [],
      });
    }

    // Buat OR filter: product_name.ilike.%<kw>%
    const orFilter = keywords
      .map((kw) => `product_name.ilike.%${kw}%`)
      .join(",");

    // Ambil produk terkait + rating
    const { data: relatedProducts, error: relErr } = await supabase
      .from("products")
      .select(`
        *,
        ratings!left (
          rating
        )
      `)
      .or(orFilter)
      .neq("id", id)
      .limit(10);

    if (relErr) throw relErr;

    // Hitung avg rating
    const relatedWithExtras = relatedProducts.map((p) => {
      let avgRating = null;
      if (p.ratings && p.ratings.length > 0) {
        const sum = p.ratings.reduce((acc, r) => acc + r.rating, 0);
        avgRating = sum / p.ratings.length;
      }
      return {
        ...p,
        avg_rating: avgRating ? Number(avgRating.toFixed(2)) : null,
        total_ratings: p.ratings ? p.ratings.length : 0,
      };
    });

    // Attach varian + stok + diskon
    const productsWithVariants =
      await attachVariantsStockDiscountWithRealDiscount(relatedWithExtras);

    return res.status(200).json({
      message: `✅ ${productsWithVariants.length} produk terkait ditemukan`,
      base_product: baseProduct,
      suggestions: productsWithVariants,
    });
  } catch (error) {
    console.error("❌ Error suggestions:", error);
    return res.status(500).json({
      message: "❌ Gagal mengambil produk terkait",
      error: error.message,
    });
  }
});
// === ROUTE UPDATE PRODUK ===
// === ROUTE UPDATE PRODUK (Konversi semua gambar ke WebP) ===
router.put("/:id", uploadForEdit, async (req, res) => {
  const productId = req.params.id;
  const {
    productName,
    productDescription,
    category_id,
    stock,
    productPrice,
    variants,
    productImagesToDelete,
  } = req.body;

  try {
    const { data: oldProduct, error: fetchErr } = await supabase
      .from("products")
      .select("*")
      .eq("id", productId)
      .single();

    if (fetchErr || !oldProduct) {
      return res.status(404).json({ message: "❌ Produk tidak ditemukan" });
    }

    // === Parsing gambar yang mau dihapus ===
    let toDelete = [];
    if (productImagesToDelete) {
      try {
        toDelete = productImagesToDelete.startsWith("[")
          ? JSON.parse(productImagesToDelete)
          : [productImagesToDelete];
      } catch {
        return res.status(400).json({
          message:
            "❌ Format productImagesToDelete tidak valid (harus JSON array atau string)",
        });
      }
    }

    // === Hapus gambar lama di storage ===
    for (let delUrl of toDelete) {
      const fileName = delUrl.split("/").pop().split("?")[0];
      await supabase.storage
        .from("product-images")
        .remove([`${oldProduct.seller_id}/products/${fileName}`]);
    }

    // === Upload gambar baru produk (convert WebP) ===
    const productImagesUrls = [];
    if (req.files && req.files["productImages"]) {
      for (let img of req.files["productImages"]) {
        const fileName = `${uuidv4()}.webp`;
        const filePath = `${oldProduct.seller_id}/products/${fileName}`;
        const webpBuffer = await convertToWebp(img.buffer);

        await supabase.storage
          .from("product-images")
          .upload(filePath, webpBuffer, {
            contentType: "image/webp",
            upsert: true,
          });

        const { data } = supabase.storage
          .from("product-images")
          .getPublicUrl(filePath);

        productImagesUrls.push(data.publicUrl);
      }
    }

    // === Gabung gambar lama (yang tidak dihapus) + baru ===
    const oldImages = Array.isArray(oldProduct.product_image_url)
      ? oldProduct.product_image_url
      : typeof oldProduct.product_image_url === "string"
        ? [oldProduct.product_image_url]
        : [];

    const remainingOldImages = oldImages.filter(
      (url) => !toDelete.includes(url),
    );
    const finalProductImages = [...remainingOldImages, ...productImagesUrls];

    let imageField = null;
    if (finalProductImages.length === 1) imageField = finalProductImages[0];
    else if (finalProductImages.length > 1) imageField = finalProductImages;

    // === Keywords baru ===
    const keywords = [
      ...generateKeywords(productName || oldProduct.product_name),
      ...generateKeywords(productDescription || oldProduct.product_description),
    ];

    // === Handle Variants (Update / Add Only) ===
    let parsedVariants = [];
    if (variants) {
      try {
        parsedVariants = JSON.parse(variants);
      } catch {
        return res
          .status(400)
          .json({ message: "❌ Format varian tidak valid (harus JSON array)" });
      }
    }

    let uploadedVariants = [];
    let totalStock = 0;
    let finalProductPrice = 0;
    let minPrice = 0;
    let maxPrice = 0;

    const { data: oldVariants } = await supabase
      .from("product_variants")
      .select("*")
      .eq("product_id", productId);

    // === Proses varian baru atau update ===
    if (Array.isArray(parsedVariants) && parsedVariants.length > 0) {
      for (let i = 0; i < parsedVariants.length; i++) {
        const v = parsedVariants[i];
        let variantImageUrl = v.image_url || null;

        // Upload gambar varian baru (convert WebP)
        if (
          req.files &&
          req.files["variantImages"] &&
          req.files["variantImages"][i]
        ) {
          const fileName = `${uuidv4()}.webp`;
          const variantPath = `${oldProduct.seller_id}/variants/${fileName}`;
          const webpBuffer = await convertToWebp(
            req.files["variantImages"][i].buffer,
          );

          await supabase.storage
            .from("product-images")
            .upload(variantPath, webpBuffer, {
              contentType: "image/webp",
              upsert: true,
            });

          const { data } = supabase.storage
            .from("product-images")
            .getPublicUrl(variantPath);
          variantImageUrl = data.publicUrl;
        }

        if (v.id) {
          // Update varian lama
          await supabase
            .from("product_variants")
            .update({
              variant_name: v.name,
              variant_price: parseFloat(v.price),
              variant_stock: parseInt(v.stock),
              variant_image_url: variantImageUrl || v.image_url,
            })
            .eq("id", v.id);
          uploadedVariants.push({
            ...v,
            variant_image_url: variantImageUrl || v.image_url,
          });
        } else {
          // Tambah varian baru
          const { data: inserted } = await supabase
            .from("product_variants")
            .insert({
              product_id: productId,
              variant_name: v.name,
              variant_price: parseFloat(v.price),
              variant_stock: parseInt(v.stock),
              variant_image_url: variantImageUrl,
            })
            .select()
            .single();

          if (inserted) {
            uploadedVariants.push({
              ...v,
              id: inserted.id,
              variant_image_url: inserted.variant_image_url,
            });
          }
        }
      }
    }

    // === Hitung ulang harga & stok ===
    const allVariants = [
      ...oldVariants,
      ...uploadedVariants.filter(
        (v) => !v.id || !oldVariants.find((o) => o.id === v.id),
      ),
    ];
    const prices = allVariants.map((v) =>
      parseFloat(v.price || v.variant_price),
    );
    const stocks = allVariants.map((v) => parseInt(v.stock || v.variant_stock));

    if (prices.length > 0) {
      minPrice = Math.min(...prices);
      maxPrice = Math.max(...prices);
      finalProductPrice = minPrice;
      totalStock = stocks.reduce((sum, s) => sum + s, 0);
    } else {
      finalProductPrice = productPrice
        ? parseFloat(productPrice)
        : oldProduct.product_price;
      totalStock = stock ? parseInt(stock) : oldProduct.stock;
      minPrice = finalProductPrice;
      maxPrice = finalProductPrice;
    }

    // === Update produk utama ===
    const { error: updateErr, data: updated } = await supabase
      .from("products")
      .update({
        product_name: productName || oldProduct.product_name,
        product_description:
          productDescription || oldProduct.product_description,
        category_id: category_id || oldProduct.category_id,
        product_price: finalProductPrice,
        min_price: minPrice,
        max_price: maxPrice,
        stock: totalStock,
        product_image_url: imageField,
        keywords,
      })
      .eq("id", productId)
      .select()
      .single();

    if (updateErr) {
      return res
        .status(500)
        .json({ message: "❌ Gagal update produk", error: updateErr.message });
    }

    return res.json({
      message: "✅ Produk berhasil diperbarui",
      data: {
        ...updated,
        variants: [...oldVariants, ...uploadedVariants],
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "❌ Terjadi kesalahan saat edit produk",
      error: error.message,
    });
  }
});

router.delete("/delete/:id", async (req, res) => {
  const { id } = req.params;
  const { type = "product", mode = "all" } = req.query;

  try {
    // === 🔁 CASE: Hapus VARIAN berdasarkan ID
    if (type === "variant") {
      const { data: variant, error: varErr } = await supabase
        .from("product_variants")
        .select("*")
        .eq("id", id)
        .single();

      if (varErr || !variant)
        return res.status(404).json({ message: "❌ Varian tidak ditemukan" });

      // Hapus gambar varian jika ada
      if (variant.variant_image_url) {
        const path = decodeURIComponent(
          variant.variant_image_url
            .split("/")
            .slice(-4)
            .join("/")
            .split("?")[0],
        );
        await supabase.storage.from("product-images").remove([path]);
      }

      // Hapus varian
      await supabase.from("product_variants").delete().eq("id", id);

      // Update stok total produk setelah varian dihapus
      const { data: remainingVariants } = await supabase
        .from("product_variants")
        .select("variant_stock")
        .eq("product_id", variant.product_id);

      const totalStock = (remainingVariants || []).reduce(
        (sum, v) => sum + v.variant_stock,
        0,
      );
      await supabase
        .from("products")
        .update({ stock: totalStock })
        .eq("id", variant.product_id);

      return res
        .status(200)
        .json({ message: "✅ Varian berhasil dihapus & stok diperbarui" });
    }

    // === 🔁 CASE: Hapus PRODUK
    const { data: product, error: findError } = await supabase
      .from("products")
      .select("*")
      .eq("id", id)
      .single();

    if (findError || !product)
      return res.status(404).json({ message: "❌ Produk tidak ditemukan" });

    const { data: variants } = await supabase
      .from("product_variants")
      .select("*")
      .eq("product_id", id);

    // Helper untuk handle array / string product_image_url
    const getProductPaths = (urls) => {
      if (!urls) return [];
      const list = Array.isArray(urls) ? urls : [urls];
      return list
        .filter(Boolean)
        .map((url) =>
          decodeURIComponent(url.split("/").slice(-4).join("/").split("?")[0]),
        );
    };

    // === 🔁 CASE: Hapus semua varian saja
    if (mode === "variant_only") {
      if (variants && variants.length > 0) {
        const variantPaths = variants
          .map((v) => v.variant_image_url)
          .filter(Boolean)
          .map((url) =>
            decodeURIComponent(
              url.split("/").slice(-4).join("/").split("?")[0],
            ),
          );

        if (variantPaths.length > 0)
          await supabase.storage.from("product-images").remove(variantPaths);
        await supabase.from("product_variants").delete().eq("product_id", id);
      }

      return res
        .status(200)
        .json({ message: "✅ Semua varian berhasil dihapus" });
    }

    // === Default: hapus produk + varian + gambar
    const productPaths = getProductPaths(product.product_image_url);

    const variantPaths = (variants || [])
      .map((v) => v.variant_image_url)
      .filter(Boolean)
      .map((url) =>
        decodeURIComponent(url.split("/").slice(-4).join("/").split("?")[0]),
      );

    if (productPaths.length > 0)
      await supabase.storage.from("product-images").remove(productPaths);
    if (variantPaths.length > 0)
      await supabase.storage.from("product-images").remove(variantPaths);

    await supabase.from("product_variants").delete().eq("product_id", id);
    await supabase.from("products").delete().eq("id", id);

    return res
      .status(200)
      .json({ message: "✅ Produk dan semua varian berhasil dihapus" });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "❌ Gagal menghapus", error: error.message });
  }
});

module.exports = router;
