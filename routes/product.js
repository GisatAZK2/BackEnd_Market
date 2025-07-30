const express = require('express');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const generateKeywords = require('../utils/keywordGenerator');

const router = express.Router();

// === Multer untuk multi gambar produk & varian ===
const uploadMulter = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('❌ Gambar harus JPEG atau PNG'));
  }
});

const uploadForCreate = uploadMulter.fields([
  { name: 'productImages', maxCount: 10 },
  { name: 'variantImages', maxCount: 10 }
]);


const uploadForEdit = uploadMulter.fields([
  { name: 'productImages', maxCount: 10 },
  { name: 'variantImages', maxCount: 10 }
]);

// === Helper: ambil variant & tentukan stok final ===
async function attachVariantsAndStock(products) {
  if (!products || products.length === 0) return [];
  const ids = products.map(p => p.id);

  const { data: variants, error } = await supabase
    .from('product_variants')
    .select('*')
    .in('product_id', ids);

  if (error) {
    console.error(error.message);
    return products.map(p => ({ ...p, variants: [], finalStock: p.stock }));
  }

  return products.map(p => {
    const vList = variants.filter(v => v.product_id === p.id);
    let finalStock = p.stock; // default manual
    if (vList.length > 0) {
      finalStock = vList.reduce((sum, v) => sum + v.variant_stock, 0);
    }
    return { ...p, variants: vList, finalStock };
  });
}

// === Upload Produk Baru ===
// === Upload Produk Baru ===
router.post('/upload', uploadForCreate, async (req, res) => {
  const {
    seller_id,
    productName,
    productDescription,
    category_id,
    stock,
    variants,
    productPrice
  } = req.body;

  if (!seller_id || !productName || !productDescription || !category_id) {
    return res.status(400).json({ message: '❌ Semua field wajib diisi' });
  }

  if (!req.files['productImages']) {
    return res.status(400).json({ message: '❌ Minimal 1 gambar produk diperlukan' });
  }

  try {
    const { data: seller } = await supabase
      .from('sellers')
      .select('*')
      .eq('id', seller_id)
      .single();

    if (!seller) {
      return res.status(404).json({ message: '❌ Seller tidak ditemukan' });
    }

    const productImagesUrls = [];
    for (let img of req.files['productImages']) {
      const fileExt = path.extname(img.originalname);
      const fileName = `${uuidv4()}${fileExt}`;
      const filePath = `${seller_id}/products/${fileName}`;

      await supabase.storage
        .from('product-images')
        .upload(filePath, img.buffer, {
          contentType: img.mimetype,
          upsert: true
        });

      const { data: urlData } = await supabase.storage
        .from('product-images')
        .createSignedUrl(filePath, 60 * 60 * 24 * 7);

      productImagesUrls.push(urlData.signedUrl);
    }

    const imageField = productImagesUrls.length === 1
      ? productImagesUrls[0]
      : productImagesUrls;

    const keywords = [
      ...generateKeywords(productName),
      ...generateKeywords(productDescription)
    ];

    let parsedVariants = [];
    try {
      if (variants) {
        parsedVariants = JSON.parse(variants);
      }
    } catch (err) {
      return res.status(400).json({ message: '❌ Format varian tidak valid' });
    }

    let uploadedVariants = [];
    let totalStock = stock ? parseInt(stock) : 0;
    let finalProductPrice = 0;
    let minPrice = 0;
    let maxPrice = 0;

    if (Array.isArray(parsedVariants) && parsedVariants.length > 0) {
      for (let i = 0; i < parsedVariants.length; i++) {
        const v = parsedVariants[i];
        let variantImageUrl = v.image_url || null;

        if (req.files['variantImages'] && req.files['variantImages'][i]) {
          const variantFile = req.files['variantImages'][i];
          const fileExt = path.extname(variantFile.originalname);
          const fileName = `${uuidv4()}${fileExt}`;
          const variantPath = `${seller_id}/variants/${fileName}`;

          await supabase.storage
            .from('product-images')
            .upload(variantPath, variantFile.buffer, {
              contentType: variantFile.mimetype,
              upsert: true
            });

          const { data: urlData } = await supabase.storage
            .from('product-images')
            .createSignedUrl(variantPath, 60 * 60 * 24 * 7);

          variantImageUrl = urlData.signedUrl;
        }

        uploadedVariants.push({
          product_id: null,
          variant_name: v.name,
          variant_price: parseFloat(v.price),
          variant_stock: parseInt(v.stock),
          variant_image_url: variantImageUrl
        });
      }

      const prices = uploadedVariants.map(v => v.variant_price);
      minPrice = Math.min(...prices);
      maxPrice = Math.max(...prices);
      finalProductPrice = minPrice;

      totalStock = uploadedVariants.reduce((sum, v) => sum + v.variant_stock, 0);

    } else {
      const parsedPrice = parseFloat(productPrice);
      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).json({
          message: '❌ Produk tanpa varian harus memiliki harga lebih dari 0 (productPrice)'
        });
      }

      finalProductPrice = parsedPrice;
      minPrice = parsedPrice;
      maxPrice = parsedPrice;
    }

    const { data: product, error: insertError } = await supabase
      .from('products')
      .insert([{
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
        product_image_url: imageField, // 🟢 string jika 1, array jika >1
        keywords
      }])
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({
        message: '❌ Gagal insert produk',
        error: insertError.message
      });
    }

    if (uploadedVariants.length > 0) {
      for (let v of uploadedVariants) {
        v.product_id = product.id;
      }
      await supabase.from('product_variants').insert(uploadedVariants);
    }

    return res.status(201).json({
      message: '✅ Produk berhasil diunggah',
      data: {
        ...product,
        variants: uploadedVariants
      }
    });

  } catch (error) {
    console.error('❌ Upload Error:', error);
    return res.status(500).json({ message: '❌ Terjadi error', error: error.message });
  }
});


// === GET produk terdekat ===
const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

router.get('/nearby-by-location', async (req, res) => {
  const { lat, lng } = req.query;
  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);
  if (isNaN(userLat) || isNaN(userLng)) return res.status(400).json({ message: '❌ Koordinat tidak valid' });

  try {
    const { data: sellers } = await supabase.from('sellers').select('id, name, latitude, longitude');
    const { data: products } = await supabase.from('products').select('*');

    const merged = products.map((product) => {
      const seller = sellers.find((s) => s.id === product.seller_id);
      const distanceInKm =
        seller && seller.latitude && seller.longitude
          ? haversineDistance(userLat, userLng, seller.latitude, seller.longitude)
          : Infinity;
      return { ...product, sellerName: seller?.name, distanceInKm: +distanceInKm.toFixed(2) };
    }).filter(p => p.distanceInKm <= 40);

    const mergedWithVariants = await attachVariantsAndStock(merged);
    return res.status(200).json({ message: `✅ Ditemukan ${mergedWithVariants.length} produk dalam radius 40 km`, products: mergedWithVariants });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal mengambil produk', error: error.message });
  }
});

// === GET semua produk ===
router.get('/allproduct', async (req, res) => {
  try {
    const { data: products } = await supabase.from('products').select('*');
    const productsWithVariants = await attachVariantsAndStock(products);
    return res.status(200).json({ message: `✅ ${products.length} produk`, products: productsWithVariants });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal mengambil semua produk', error: error.message });
  }
});

// === GET produk berdasarkan kategori ===
router.get('/by-category/:category_id', async (req, res) => {
  const { category_id } = req.params;
  try {
    const { data: category } = await supabase.from('categories').select('id, name').eq('id', category_id).single();
    if (!category) return res.status(404).json({ message: '❌ Kategori tidak ditemukan' });

    const { data: products } = await supabase.from('products').select('*').eq('category_id', category_id);
    const productsWithVariants = await attachVariantsAndStock(products);
    return res.status(200).json({ message: `✅ Ditemukan ${products.length} produk dalam kategori "${category.name}"`, category: category.name, products: productsWithVariants });
  } catch (error) {
    return res.status(500).json({ message: '❌ Server error', error: error.message });
  }
});

// === GET produk by ID ===
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: product } = await supabase.from('products').select('*').eq('id', id).single();
    if (!product) return res.status(404).json({ message: '❌ Produk tidak ditemukan' });

    const productsWithVariants = await attachVariantsAndStock([product]);
    return res.status(200).json({ message: '✅ Produk ditemukan', product: productsWithVariants[0] });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal mengambil produk', error: error.message });
  }
});


// === ROUTE UPDATE PRODUK ===
router.put('/:id', uploadForEdit, async (req, res) => {
  const productId = req.params.id;
  const {
    productName,
    productDescription,
    category_id,
    stock,
    productPrice,
    variants,
    productImagesToDelete
  } = req.body;

  try {
    const { data: oldProduct, error: fetchErr } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .single();

    if (fetchErr || !oldProduct) {
      return res.status(404).json({ message: '❌ Produk tidak ditemukan' });
    }

    // === Parsing gambar yang mau dihapus ===
    let toDelete = [];
    if (productImagesToDelete) {
      try {
        toDelete = productImagesToDelete.startsWith('[')
          ? JSON.parse(productImagesToDelete)
          : [productImagesToDelete];
      } catch {
        return res.status(400).json({
          message: '❌ Format productImagesToDelete tidak valid (harus JSON array atau string)'
        });
      }
    }

    // === Hapus gambar lama di storage ===
    for (let delUrl of toDelete) {
      const fileName = delUrl.split('/').pop().split('?')[0];
      await supabase.storage
        .from('product-images')
        .remove([`${oldProduct.seller_id}/products/${fileName}`]);
    }

    // === Upload gambar baru produk ===
    const productImagesUrls = [];
    if (req.files && req.files['productImages']) {
      for (let img of req.files['productImages']) {
        const ext = path.extname(img.originalname);
        const fileName = `${uuidv4()}${ext}`;
        const filePath = `${oldProduct.seller_id}/products/${fileName}`;

        await supabase.storage.from('product-images').upload(filePath, img.buffer, {
          contentType: img.mimetype,
          upsert: true
        });

        const { data: urlData } = await supabase.storage
          .from('product-images')
          .createSignedUrl(filePath, 60 * 60 * 24 * 7);

        productImagesUrls.push(urlData.signedUrl);
      }
    }

    // === Gabung gambar lama (yang tidak dihapus) + baru ===
    const oldImages = Array.isArray(oldProduct.product_image_url)
      ? oldProduct.product_image_url
      : typeof oldProduct.product_image_url === 'string'
        ? [oldProduct.product_image_url]
        : [];

    const remainingOldImages = oldImages.filter(url => !toDelete.includes(url));
    const finalProductImages = [...remainingOldImages, ...productImagesUrls];

    let imageField = null;
    if (finalProductImages.length === 1) {
      imageField = finalProductImages[0];
    } else if (finalProductImages.length > 1) {
      imageField = finalProductImages;
    }

    // === Keywords baru ===
    const keywords = [
      ...generateKeywords(productName || oldProduct.product_name),
      ...generateKeywords(productDescription || oldProduct.product_description)
    ];

    // === Handle Variants (Update / Add Only) ===
    let parsedVariants = [];
    if (variants) {
      try {
        parsedVariants = JSON.parse(variants);
      } catch {
        return res.status(400).json({ message: '❌ Format varian tidak valid (harus JSON array)' });
      }
    }

    let uploadedVariants = [];
    let totalStock = 0;
    let finalProductPrice = 0;
    let minPrice = 0;
    let maxPrice = 0;

    // Ambil varian lama untuk kalkulasi harga/stock
    const { data: oldVariants } = await supabase
      .from('product_variants')
      .select('*')
      .eq('product_id', productId);

    // Proses varian baru atau update
    if (Array.isArray(parsedVariants) && parsedVariants.length > 0) {
      for (let i = 0; i < parsedVariants.length; i++) {
        const v = parsedVariants[i];
        let variantImageUrl = v.image_url || null;

        // Upload gambar baru jika ada
        if (req.files && req.files['variantImages'] && req.files['variantImages'][i]) {
          const file = req.files['variantImages'][i];
          const ext = path.extname(file.originalname);
          const fileName = `${uuidv4()}${ext}`;
          const filePath = `${oldProduct.seller_id}/variants/${fileName}`;

          await supabase.storage.from('product-images').upload(filePath, file.buffer, {
            contentType: file.mimetype,
            upsert: true
          });

          const { data: urlData } = await supabase.storage
            .from('product-images')
            .createSignedUrl(filePath, 60 * 60 * 24 * 7);
          variantImageUrl = urlData.signedUrl;
        }

        if (v.id) {
          // Update varian lama
          await supabase.from('product_variants')
            .update({
              variant_name: v.name,
              variant_price: parseFloat(v.price),
              variant_stock: parseInt(v.stock),
              variant_image_url: variantImageUrl || v.image_url
            })
            .eq('id', v.id);
          uploadedVariants.push({ ...v, variant_image_url: variantImageUrl || v.image_url });
        } else {
          // Tambah varian baru
          const { data: inserted } = await supabase.from('product_variants')
            .insert({
              product_id: productId,
              variant_name: v.name,
              variant_price: parseFloat(v.price),
              variant_stock: parseInt(v.stock),
              variant_image_url: variantImageUrl
            })
            .select()
            .single();

          if (inserted) {
            uploadedVariants.push({ ...v, id: inserted.id, variant_image_url: inserted.variant_image_url });
          }
        }
      }
    }

    // === Hitung ulang harga & stok ===
    const allVariants = [...oldVariants, ...uploadedVariants.filter(v => !v.id || !oldVariants.find(o => o.id === v.id))];
    const prices = allVariants.map(v => parseFloat(v.price || v.variant_price));
    const stocks = allVariants.map(v => parseInt(v.stock || v.variant_stock));

    if (prices.length > 0) {
      minPrice = Math.min(...prices);
      maxPrice = Math.max(...prices);
      finalProductPrice = minPrice;
      totalStock = stocks.reduce((sum, s) => sum + s, 0);
    } else {
      finalProductPrice = productPrice ? parseFloat(productPrice) : oldProduct.product_price;
      totalStock = stock ? parseInt(stock) : oldProduct.stock;
      minPrice = finalProductPrice;
      maxPrice = finalProductPrice;
    }

    // === Update produk utama ===
    const { error: updateErr, data: updated } = await supabase
      .from('products')
      .update({
        product_name: productName || oldProduct.product_name,
        product_description: productDescription || oldProduct.product_description,
        category_id: category_id || oldProduct.category_id,
        product_price: finalProductPrice,
        min_price: minPrice,
        max_price: maxPrice,
        stock: totalStock,
        product_image_url: imageField,
        keywords
      })
      .eq('id', productId)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ message: '❌ Gagal update produk', error: updateErr.message });
    }

    return res.json({
      message: '✅ Produk berhasil diperbarui',
      data: {
        ...updated,
        variants: [...oldVariants, ...uploadedVariants]
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: '❌ Terjadi kesalahan saat edit produk', error: error.message });
  }
});


router.delete('/delete/:id', async (req, res) => {
  const { id } = req.params;
  const { type = 'product', mode = 'all' } = req.query;

  try {
    // === 🔁 CASE: Hapus VARIAN berdasarkan ID
    if (type === 'variant') {
      const { data: variant, error: varErr } = await supabase
        .from('product_variants')
        .select('*')
        .eq('id', id)
        .single();

      if (varErr || !variant) return res.status(404).json({ message: '❌ Varian tidak ditemukan' });

      // Hapus gambar varian jika ada
      if (variant.variant_image_url) {
        const path = decodeURIComponent(variant.variant_image_url.split('/').slice(-4).join('/').split('?')[0]);
        await supabase.storage.from('product-images').remove([path]);
      }

      // Hapus varian
      await supabase.from('product_variants').delete().eq('id', id);

      // Update stok total produk setelah varian dihapus
      const { data: remainingVariants } = await supabase
        .from('product_variants')
        .select('variant_stock')
        .eq('product_id', variant.product_id);

      const totalStock = (remainingVariants || []).reduce((sum, v) => sum + v.variant_stock, 0);
      await supabase.from('products').update({ stock: totalStock }).eq('id', variant.product_id);

      return res.status(200).json({ message: '✅ Varian berhasil dihapus & stok diperbarui' });
    }

    // === 🔁 CASE: Hapus PRODUK
    const { data: product, error: findError } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (findError || !product) return res.status(404).json({ message: '❌ Produk tidak ditemukan' });

    const { data: variants } = await supabase
      .from('product_variants')
      .select('*')
      .eq('product_id', id);

    // Helper untuk handle array / string product_image_url
    const getProductPaths = (urls) => {
      if (!urls) return [];
      const list = Array.isArray(urls) ? urls : [urls];
      return list
        .filter(Boolean)
        .map(url => decodeURIComponent(url.split('/').slice(-4).join('/').split('?')[0]));
    };

    // === 🔁 CASE: Hapus semua varian saja
    if (mode === 'variant_only') {
      if (variants && variants.length > 0) {
        const variantPaths = variants
          .map(v => v.variant_image_url)
          .filter(Boolean)
          .map(url => decodeURIComponent(url.split('/').slice(-4).join('/').split('?')[0]));

        if (variantPaths.length > 0) await supabase.storage.from('product-images').remove(variantPaths);
        await supabase.from('product_variants').delete().eq('product_id', id);
      }

      return res.status(200).json({ message: '✅ Semua varian berhasil dihapus' });
    }

    // === Default: hapus produk + varian + gambar
    const productPaths = getProductPaths(product.product_image_url);

    const variantPaths = (variants || [])
      .map(v => v.variant_image_url)
      .filter(Boolean)
      .map(url => decodeURIComponent(url.split('/').slice(-4).join('/').split('?')[0]));

    if (productPaths.length > 0) await supabase.storage.from('product-images').remove(productPaths);
    if (variantPaths.length > 0) await supabase.storage.from('product-images').remove(variantPaths);

    await supabase.from('product_variants').delete().eq('product_id', id);
    await supabase.from('products').delete().eq('id', id);

    return res.status(200).json({ message: '✅ Produk dan semua varian berhasil dihapus' });
  } catch (error) {
    return res.status(500).json({ message: '❌ Gagal menghapus', error: error.message });
  }
});

// === ROUTE OGP Meta Produk ===
router.get('/ogp/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !product) {
      return res.status(404).send('<h1>❌ Produk tidak ditemukan</h1>');
    }

    // --- Ambil gambar utama ---
    let ogImage = '';
    if (Array.isArray(product.product_image_url)) {
      ogImage = product.product_image_url[0] || '';
    } else if (typeof product.product_image_url === 'string') {
      try {
        const parsed = JSON.parse(product.product_image_url);
        ogImage = Array.isArray(parsed) ? (parsed[0] || '') : product.product_image_url;
      } catch (e) {
        ogImage = product.product_image_url;
      }
    }

    const ogUrl = `https://cihuy.sytes.net/detail/produk/${encodeURIComponent(product.product_name)}/${id}`;
    const jsonLD = {
      "@context": "https://schema.org/",
      "@type": "Product",
      "name": product.product_name,
      "description": product.product_description || "",
      "image": ogImage,
      "sku": id,
      "brand": {
        "@type": "Brand",
        "name": "CIHUY STORE"
      },
      "offers": {
        "@type": "Offer",
        "url": ogUrl,
        "availability": "https://schema.org/InStock"
      }
    };

    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <title>${product.product_name}</title>
    <meta name="description" content="${product.product_description || ''}" />

    <!-- Open Graph (Facebook, WhatsApp, Discord, LinkedIn) -->
    <meta property="og:title" content="${product.product_name}" />
    <meta property="og:description" content="${product.product_description || ''}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:url" content="${ogUrl}" />
    <meta property="og:type" content="product" />
    <meta property="og:site_name" content="CIHUY STORE" />

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${product.product_name}" />
    <meta name="twitter:description" content="${product.product_description || ''}" />
    <meta name="twitter:image" content="${ogImage}" />
    <meta name="twitter:site" content="@cihuy_store" />

    <!-- JSON-LD Structured Data -->
    <script type="application/ld+json">
      ${JSON.stringify(jsonLD)}
    </script>
</head>

<body>
    <h1>${product.product_name}</h1>
    <p>${product.product_description || ''}</p>
    ${ogImage ? `<img src="${ogImage}" alt="${product.product_name}" style="max-width:400px" />` : ''}
</body>
</html>
`;

    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('<h1>Terjadi kesalahan server</h1>');
  }
});


module.exports = router;






