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

const uploadForEdit = uploadMulter.array('productImages', 10);

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
router.post('/upload', uploadForCreate, async (req, res) => {
  const {
    seller_id,
    productName,
    productDescription,
    productPrice,
    category_id,
    stock, // manual kalau tidak ada varian
    variants // JSON string
  } = req.body;

  if (!seller_id || !productName || !productDescription || !productPrice || !category_id) {
    return res.status(400).json({ message: '❌ Semua field wajib diisi' });
  }
  if (!req.files['productImages']) {
    return res.status(400).json({ message: '❌ Minimal 1 gambar produk diperlukan' });
  }

  const priceNum = parseFloat(productPrice);
  const stockNum = stock ? parseInt(stock) : 0;
  if (isNaN(priceNum) || priceNum <= 0) return res.status(400).json({ message: '❌ Harga tidak valid' });

  try {
    const { data: seller } = await supabase.from('sellers').select('*').eq('id', seller_id).single();
    if (!seller) return res.status(404).json({ message: '❌ Seller tidak ditemukan' });

    // Upload multi gambar produk
    const productImagesUrls = [];
    for (let img of req.files['productImages']) {
      const fileExt = path.extname(img.originalname);
      const fileName = `${uuidv4()}${fileExt}`;
      const filePath = `${seller_id}/products/${fileName}`;
      await supabase.storage.from('product-images').upload(filePath, img.buffer, { contentType: img.mimetype, upsert: true });
      const { data: urlData } = await supabase.storage.from('product-images').createSignedUrl(filePath, 60 * 60 * 24 * 7);
      productImagesUrls.push(urlData.signedUrl);
    }

    const keywords = [...generateKeywords(productName), ...generateKeywords(productDescription)];

    // Insert produk
    const { data: product } = await supabase
      .from('products')
      .insert([{
        seller_id,
        category_id,
        seller_name: seller.name,
        seller_email: seller.email,
        product_name: productName,
        product_description: productDescription,
        product_price: priceNum,
        stock: stockNum,
        product_image_url: productImagesUrls,
        keywords
      }])
      .select()
      .single();

    // Variants
    let parsedVariants = [];
    if (variants) {
      try { parsedVariants = JSON.parse(variants); }
      catch { return res.status(400).json({ message: '❌ Format varian tidak valid' }); }
    }

    if (Array.isArray(parsedVariants) && parsedVariants.length > 0) {
      const uploadedVariants = [];
      for (let i = 0; i < parsedVariants.length; i++) {
        const v = parsedVariants[i];
        let variantImageUrl = v.image_url || null;
        if (req.files['variantImages'] && req.files['variantImages'][i]) {
          const variantFile = req.files['variantImages'][i];
          const fileExt = path.extname(variantFile.originalname);
          const fileName = `${uuidv4()}${fileExt}`;
          const variantPath = `${seller_id}/variants/${fileName}`;
          await supabase.storage.from('product-images').upload(variantPath, variantFile.buffer, { contentType: variantFile.mimetype, upsert: true });
          const { data: urlData } = await supabase.storage.from('product-images').createSignedUrl(variantPath, 60 * 60 * 24 * 7);
          variantImageUrl = urlData.signedUrl;
        }
        uploadedVariants.push({
          product_id: product.id,
          variant_name: v.name,
          variant_price: parseFloat(v.price),
          variant_stock: parseInt(v.stock),
          variant_image_url: variantImageUrl
        });
      }
      await supabase.from('product_variants').insert(uploadedVariants);

      // Update stok produk = total stok varian
      const totalStock = uploadedVariants.reduce((sum, v) => sum + v.variant_stock, 0);
      await supabase.from('products').update({ stock: totalStock }).eq('id', product.id);
    }

    return res.status(201).json({ message: '✅ Produk berhasil diunggah', data: product });
  } catch (error) {
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


router.put('/edit/:id', uploadForCreate, async (req, res) => {
  const { id } = req.params;
  const {
    productName,
    productDescription,
    productPrice,
    category_id,
    stock,
    variants // ← JSON string
  } = req.body;

  try {
    const { data: existingProduct, error: findError } = await supabase.from('products').select('*').eq('id', id).single();
    if (findError || !existingProduct) return res.status(404).json({ message: '❌ Produk tidak ditemukan' });

    let newProductImagesUrls = existingProduct.product_image_url || [];

    // === Ganti gambar produk
    if (req.files['productImages']) {
      // Hapus gambar lama
      const oldProductPaths = existingProduct.product_image_url.map((url) => {
        const parts = url.split('/'); // ambil path dari signedUrl
        return decodeURIComponent(parts.slice(-4).join('/').split('?')[0]); // contoh: seller_id/products/uuid.png
      });
      await supabase.storage.from('product-images').remove(oldProductPaths);

      // Upload gambar baru
      newProductImagesUrls = [];
      for (let img of req.files['productImages']) {
        const fileExt = path.extname(img.originalname);
        const fileName = `${uuidv4()}${fileExt}`;
        const filePath = `${existingProduct.seller_id}/products/${fileName}`;
        await supabase.storage.from('product-images').upload(filePath, img.buffer, { contentType: img.mimetype, upsert: true });
        const { data: urlData } = await supabase.storage.from('product-images').createSignedUrl(filePath, 60 * 60 * 24 * 7);
        newProductImagesUrls.push(urlData.signedUrl);
      }
    }

    // === Update produk
    const updatedProduct = {
      product_name: productName || existingProduct.product_name,
      product_description: productDescription || existingProduct.product_description,
      product_price: productPrice ? parseFloat(productPrice) : existingProduct.product_price,
      category_id: category_id || existingProduct.category_id,
      stock: stock ? parseInt(stock) : existingProduct.stock,
      product_image_url: newProductImagesUrls
    };

    await supabase.from('products').update(updatedProduct).eq('id', id);

    // === Update varian
    let parsedVariants = [];
    if (variants) {
      try {
        parsedVariants = JSON.parse(variants);
      } catch {
        return res.status(400).json({ message: '❌ Format varian tidak valid' });
      }
    }

    if (Array.isArray(parsedVariants)) {
      for (let i = 0; i < parsedVariants.length; i++) {
        const v = parsedVariants[i];

        let variantImageUrl = v.image_url || null;

        if (req.files['variantImages'] && req.files['variantImages'][i]) {
          // Hapus gambar lama jika ada
          if (v.image_url) {
            const urlParts = v.image_url.split('/');
            const variantPath = decodeURIComponent(urlParts.slice(-4).join('/').split('?')[0]);
            await supabase.storage.from('product-images').remove([variantPath]);
          }

          const variantFile = req.files['variantImages'][i];
          const fileExt = path.extname(variantFile.originalname);
          const fileName = `${uuidv4()}${fileExt}`;
          const newVariantPath = `${existingProduct.seller_id}/variants/${fileName}`;
          await supabase.storage.from('product-images').upload(newVariantPath, variantFile.buffer, { contentType: variantFile.mimetype, upsert: true });
          const { data: urlData } = await supabase.storage.from('product-images').createSignedUrl(newVariantPath, 60 * 60 * 24 * 7);
          variantImageUrl = urlData.signedUrl;
        }

        if (v.id) {
          // Update existing varian
          await supabase.from('product_variants').update({
            variant_name: v.name,
            variant_price: parseFloat(v.price),
            variant_stock: parseInt(v.stock),
            variant_image_url: variantImageUrl
          }).eq('id', v.id);
        } else {
          // Insert baru
          await supabase.from('product_variants').insert({
            product_id: id,
            variant_name: v.name,
            variant_price: parseFloat(v.price),
            variant_stock: parseInt(v.stock),
            variant_image_url: variantImageUrl
          });
        }
      }

      // Update stok total dari semua varian
      const { data: updatedVariants } = await supabase.from('product_variants').select('variant_stock').eq('product_id', id);
      const totalStock = updatedVariants.reduce((sum, v) => sum + v.variant_stock, 0);
      await supabase.from('products').update({ stock: totalStock }).eq('id', id);
    }

    return res.status(200).json({ message: '✅ Produk dan varian berhasil diupdate' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: '❌ Gagal update', error: error.message });
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

    if (mode === 'product_only') {
      const productPaths = (product.product_image_url || []).map(url =>
        decodeURIComponent(url.split('/').slice(-4).join('/').split('?')[0])
      );

      if (productPaths.length > 0) await supabase.storage.from('product-images').remove(productPaths);
      await supabase.from('products').delete().eq('id', id);

      return res.status(200).json({ message: '✅ Produk saja berhasil dihapus (varian tetap)' });
    }

    // === Default: hapus produk + varian + gambar
    const productPaths = (product.product_image_url || []).map(url =>
      decodeURIComponent(url.split('/').slice(-4).join('/').split('?')[0])
    );

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


module.exports = router;
