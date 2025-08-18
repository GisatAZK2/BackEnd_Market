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

/* ===== STORE DISCOUNT CREATE ===== */
router.post("/store-discount/create", async (req, res) => {
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
    // 🔍 Cek duplikat diskon (nama + periode sama)
    const { data: existingDiscount, error: checkErr } = await supabase
      .from("store_discounts")
      .select("id")
      .eq("store_id", sellerInfo.id)
      .eq("name", name)
      .eq("start_time", startUTC)
      .eq("end_time", endUTC)
      .maybeSingle();

    if (checkErr) {
      return res.status(500).json({ message: "❌ Gagal cek duplikat", error: checkErr.message });
    }

    if (existingDiscount) {
      return res.status(409).json({
        message: "❌ Diskon dengan nama & periode sama sudah ada",
      });
    }

    // 🔍 Ambil semua diskon aktif toko ini
    const nowISO = new Date().toISOString();
    const { data: activeDiscounts, error: activeDiscErr } = await supabase
      .from("store_discounts")
      .select("id")
      .eq("store_id", sellerInfo.id)
      .gt("end_time", nowISO);

    if (activeDiscErr) {
      return res.status(500).json({ message: "❌ Gagal ambil diskon aktif", error: activeDiscErr.message });
    }

    const activeDiscountIds = activeDiscounts?.map(d => d.id) || [];

    // 🔍 Validasi: pastikan produk/varian belum ada di diskon aktif
    for (const item of items) {
      if (item.variants?.length) {
        for (const variant of item.variants) {
          if (activeDiscountIds.length > 0) {
            const { data: activeItem, error: activeErr } = await supabase
              .from("store_discount_items")
              .select("id")
              .eq("product_id", item.product_id)
              .eq("variant_id", variant.variant_id)
              .in("discount_id", activeDiscountIds);

            if (activeErr) {
              return res.status(500).json({ message: "❌ Gagal cek produk aktif", error: activeErr.message });
            }
            if (activeItem?.length) {
              return res.status(409).json({
                message: `❌ Produk ${item.product_id} varian ${variant.variant_id} sudah ada di diskon aktif`,
              });
            }
          }
        }
      } else {
        if (activeDiscountIds.length > 0) {
          const { data: activeItem, error: activeErr } = await supabase
            .from("store_discount_items")
            .select("id")
            .eq("product_id", item.product_id)
            .is("variant_id", null)
            .in("discount_id", activeDiscountIds);

          if (activeErr) {
            return res.status(500).json({ message: "❌ Gagal cek produk aktif", error: activeErr.message });
          }
          if (activeItem?.length) {
            return res.status(409).json({
              message: `❌ Produk ${item.product_id} sudah ada di diskon aktif`,
            });
          }
        }
      }
    }

    // ✅ Simpan store_discounts
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

    // ✅ Insert item discount
    for (const item of items) {
      if (item.variants?.length) {
        for (const variant of item.variants) {
          await supabase.from("store_discount_items").insert([{
            discount_id: storeDiscount.id,
            product_id: item.product_id,
            variant_id: variant.variant_id,
            stock: variant.stock,
            discount_percentage: variant.discount_percentage,
          }]);
        }
      } else {
        await supabase.from("store_discount_items").insert([{
          discount_id: storeDiscount.id,
          product_id: item.product_id,
          variant_id: null,
          stock: item.stock,
          discount_percentage: item.discount_percentage,
        }]);
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

/**
 * GET /store-discount/available-products
 * Ambil semua produk/varian yang sedang ikut diskon aktif
 */
router.get("/store-discount/available-products", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info
      ? JSON.parse(req.cookies.seller_info)
      : null;

    if (!sellerInfo?.id) {
      return res.status(401).json({ error: "❌ Harus login sebagai seller" });
    }

    const { data: sellerData, error: sellerErr } = await supabase
      .from("sellers")
      .select("id, name")
      .eq("id", sellerInfo.id)
      .single();

    if (sellerErr || !sellerData) {
      return res.status(404).json({ error: "❌ Seller tidak ditemukan" });
    }

    const sellerName = sellerData.name;
    const now = new Date().toISOString();

    const { data: discountItems = [], error: discountErr } = await supabase
      .from("store_discount_items")
      .select(`
        id,
        product_id,
        variant_id,
        discount_percentage,
        stock,
        store_discounts(id, name, start_time, end_time, store_id),
        products(*, seller_name, product_image_url),
        product_variants(*, variant_image_url)
      `)
      .gte("store_discounts.start_time", now)
      .lte("store_discounts.end_time", now);

    if (discountErr) throw discountErr;

    // 🔹 Grouping diskon per product
    const grouped = discountItems.reduce((acc, item) => {
      if (!item.products || item.products.seller_name !== sellerName) return acc;

      const existing = acc.find(p => p.product_id === item.product_id);
      const variantStock = item.product_variants?.variant_stock ?? null;

      const variantData = item.variant_id
        ? {
            variant_id: item.variant_id,
            stock: item.stock ?? variantStock,
            discount_percentage: item.discount_percentage,
            variant_data: item.product_variants
              ? {
                  variant_name: item.product_variants.variant_name,
                  variant_stock: item.product_variants.variant_stock,
                  variant_image_url: item.product_variants.variant_image_url || null
                }
              : null,
            is_on_discount: true
          }
        : null;

      if (existing) {
        if (variantData) {
          const existsVar = existing.variants.find(v => v.variant_id === variantData.variant_id);
          if (!existsVar) existing.variants.push(variantData);
        }
      } else {
        acc.push({
          product_id: item.product_id,
          product_data: {
            product_name: item.products.product_name,
            product_description: item.products.product_description,
            stock: item.variant_id ? null : item.stock ?? item.products.stock,
            seller_name: sellerName,
            product_image_url: item.products.product_image_url || null,
            is_on_discount: item.variant_id ? undefined : true
          },
          stock: item.variant_id ? null : item.stock ?? item.products.stock,
          discount_percentage: item.variant_id ? null : item.discount_percentage,
          variants: variantData ? [variantData] : []
        });
      }

      return acc;
    }, []);

    const { data: allProducts = [], error: allProdErr } = await supabase
      .from("products")
      .select("*, product_variants(*)")
      .eq("seller_name", sellerName);

    if (allProdErr) throw allProdErr;

    // 🔹 Merge produk yang belum diskon & beri is_on_discount false ke semua variant
    const mergedProducts = allProducts.map(prod => {
      const found = grouped.find(g => g.product_id === prod.id);
      if (found) {
        found.variants = (prod.product_variants || []).map(v => {
          const existingVar = found.variants.find(fv => fv.variant_id === v.id);
          if (existingVar) return existingVar;
          return {
            variant_id: v.id,
            stock: v.stock,
            discount_percentage: null,
            is_on_discount: false,
            variant_data: {
              variant_name: v.variant_name,
              variant_stock: v.stock,
              variant_image_url: v.variant_image_url || null
            }
          };
        });
        return found;
      }

      const variants = (prod.product_variants || []).map(v => ({
        variant_id: v.id,
        stock: v.stock,
        discount_percentage: null,
        is_on_discount: false,
        variant_data: {
          variant_name: v.variant_name,
          variant_stock: v.stock,
          variant_image_url: v.variant_image_url || null
        }
      }));

      return {
        product_id: prod.id,
        product_data: {
          product_name: prod.product_name,
          product_description: prod.product_description,
          stock: variants.length ? null : prod.stock,
          seller_name: sellerName,
          product_image_url: prod.product_image_url || null,
          is_on_discount: variants.length ? undefined : false
        },
        stock: variants.length ? null : prod.stock,
        discount_percentage: null,
        variants
      };
    });

    return res.json({
      message: "✅ Daftar produk dengan status diskon",
      items: mergedProducts
    });

  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


/* ===== GET ALL STORE DISCOUNT (BY SELLER - pakai cookies) ===== */
router.get("/store-discount/all", async (req, res) => {
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

    // hanya return diskon tanpa relasi product/variant
    return res.json({
      message: "✅ Semua diskon toko berhasil diambil",
      data: storeDiscounts,
    });
  } catch (err) {
    console.error("❌ Error get seller discounts lite:", err);
    res.status(500).json({ message: "❌ Error server", error: err.message });
  }
});

router.get("/store-discount/:id", async (req, res) => {
  const sellerInfo = req.cookies?.seller_info
    ? JSON.parse(req.cookies.seller_info)
    : null;

  if (!sellerInfo?.id) {
    return res.status(401).json({ error: "❌ Harus login sebagai seller" });
  }

  const { id } = req.params;

  try {
    // Ambil data diskon
    const { data: discount, error } = await supabase
      .from("store_discounts")
      .select("*")
      .eq("store_id", sellerInfo.id)
      .eq("id", id)
      .single();

    if (error || !discount) {
      return res.status(404).json({ message: "❌ Diskon tidak ditemukan" });
    }

    // Ambil semua item diskon beserta produk & varian
    const { data: rawItems = [] } = await supabase
      .from("store_discount_items")
      .select("id, product_id, variant_id, stock, discount_percentage, products(*), product_variants(*)")
      .eq("discount_id", discount.id);

    // 🔥 Group items dan filter stock/variant + ambil image
    const groupedItems = rawItems.reduce((acc, item) => {
      const existing = acc.find(p => p.product_id === item.product_id);

      const variantData = item.product_variants
        ? {
            variant_name: item.product_variants.variant_name,
            variant_stock: item.product_variants.variant_stock
          }
        : null;

      // Ambil stock dari product atau varian pertama jika stock null
      const productStock = item.products?.stock ?? variantData?.variant_stock ?? null;

      const productData = item.products
        ? {
            product_name: item.products.product_name,
            product_description: item.products.product_description,
            product_image_url: item.products.product_image_url, // ambil field image
            stock: productStock
          }
        : { stock: productStock };

      if (existing) {
        if (item.variant_id) {
          existing.variants.push({
            variant_id: item.variant_id,
            stock: item.stock ?? variantData?.variant_stock ?? null,
            discount_percentage: item.discount_percentage,
            variant_data: variantData
          });

          // update stock product jika masih null
          if (!existing.product_data.stock && variantData?.variant_stock != null) {
            existing.product_data.stock = variantData.variant_stock;
          }
        } else {
          existing.stock = item.stock;
          existing.discount_percentage = item.discount_percentage;
        }
      } else {
        acc.push({
          product_id: item.product_id,
          product_data: productData,
          stock: productStock, // ambil langsung dari productStock
          discount_percentage: item.variant_id ? null : item.discount_percentage,
          variants: item.variant_id
            ? [
                {
                  variant_id: item.variant_id,
                  stock: item.stock ?? variantData?.variant_stock ?? null,
                  discount_percentage: item.discount_percentage,
                  variant_data: variantData
                }
              ]
            : []
        });
      }

      return acc;
    }, []);

    return res.json({
      message: "✅ Diskon berhasil diambil",
      data: { ...discount, items: groupedItems },
    });
  } catch (err) {
    console.error("❌ Error get discount by id:", err);
    res.status(500).json({ message: "❌ Error server", error: err.message });
  }
});

router.post("/store-discount/duplicate/:id", async (req, res) => {
  const sellerInfo = req.cookies?.seller_info
    ? JSON.parse(req.cookies.seller_info)
    : null;

  if (!sellerInfo?.id) return res.status(401).json({ error: "❌ Harus login sebagai seller" });

  const { newName, newStartTime, newEndTime, timezone } = req.body;
  const tz = timezone || "Asia/Jakarta";
  const startUTC = DateTime.fromISO(newStartTime, { zone: tz }).toUTC().toISO();
  const endUTC = DateTime.fromISO(newEndTime, { zone: tz }).toUTC().toISO();

  try {
    // Ambil diskon lama
    const { data: oldDiscount, error: fetchErr } = await supabase
      .from("store_discounts")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (fetchErr || !oldDiscount) return res.status(404).json({ message: "❌ Diskon lama tidak ditemukan" });

    // Insert diskon baru
    const { data: newDiscount, error: insertErr } = await supabase
      .from("store_discounts")
      .insert([{ store_id: sellerInfo.id, name: newName || oldDiscount.name, start_time: startUTC, end_time: endUTC }])
      .select()
      .single();

    if (insertErr) return res.status(500).json({ message: "❌ Gagal duplikat diskon", error: insertErr.message });

    // Duplikat item diskon
    const { data: items, error: itemsErr } = await supabase
      .from("store_discount_items")
      .select("*")
      .eq("discount_id", oldDiscount.id);

    if (itemsErr) return res.status(500).json({ message: "❌ Gagal ambil item diskon", error: itemsErr.message });

    for (const item of items) {
      await supabase.from("store_discount_items").insert([{
        discount_id: newDiscount.id,
        product_id: item.product_id,
        variant_id: item.variant_id,
        stock: item.stock,
        discount_percentage: item.discount_percentage,
      }]);
    }

    return res.json({ message: "✅ Diskon berhasil diduplikasi", store_discount: newDiscount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "❌ Error server", error: err.message });
  }
});


router.put("/store-discount/edit/:id", async (req, res) => {
  const sellerInfo = req.cookies?.seller_info
    ? JSON.parse(req.cookies.seller_info)
    : null;

  if (!sellerInfo?.id)
    return res.status(401).json({ error: "❌ Harus login sebagai seller" });

  const { items } = req.body; // format: [{ product_id, variant_id, stock, discount_percentage }]

  try {
    for (const item of items) {
      // 🔹 Cek apakah item/variant sudah ada
      let query = supabase
        .from("store_discount_items")
        .select("*")
        .eq("discount_id", req.params.id)
        .eq("product_id", item.product_id);

      if (item.variant_id) {
        query = query.eq("variant_id", item.variant_id);
      } else {
        query = query.is("variant_id", null);
      }

      const { data: existing, error: existErr } = await query.maybeSingle();
      if (existErr)
        return res.status(500).json({
          message: "❌ Gagal cek item diskon",
          error: existErr.message,
        });

      if (existing) {
        // 🔹 Update stock / discount_percentage
        await supabase
          .from("store_discount_items")
          .update({
            stock: item.stock ?? existing.stock,
            discount_percentage:
              item.discount_percentage ?? existing.discount_percentage,
          })
          .eq("id", existing.id);
      } else {
        // 🔹 Insert item baru
        await supabase.from("store_discount_items").insert([
          {
            discount_id: req.params.id,
            product_id: item.product_id,
            variant_id: item.variant_id || null,
            stock: item.stock,
            discount_percentage: item.discount_percentage,
          },
        ]);
      }
    }

    return res.json({ message: "✅ Diskon berhasil diperbarui" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "❌ Error server",
      error: err.message,
    });
  }
});

router.delete("/store-discount/:id", async (req, res) => {
  const sellerInfo = req.cookies?.seller_info
    ? JSON.parse(req.cookies.seller_info)
    : null;

  if (!sellerInfo?.id)
    return res.status(401).json({ error: "❌ Harus login sebagai seller" });

  const { product_id, variant_id } = req.query;

  try {
    if (product_id) {
      // Mode hapus item tertentu
      const query = supabase.from("store_discount_items").delete()
        .eq("discount_id", req.params.id)
        .eq("product_id", product_id);

      if (variant_id) query.eq("variant_id", variant_id);
      else query.is("variant_id", null);

      const { error } = await query;
      if (error) return res.status(500).json({ message: "❌ Gagal hapus item", error: error.message });

      return res.json({ message: `✅ Item ${product_id}${variant_id ? ' varian ' + variant_id : ''} berhasil dihapus dari diskon` });
    } else {
      // Mode hapus seluruh diskon
      await supabase.from("store_discount_items").delete().eq("discount_id", req.params.id);
      await supabase.from("store_discounts").delete().eq("id", req.params.id);
      return res.json({ message: "✅ Diskon berhasil dihapus" });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "❌ Error server", error: err.message });
  }
});


/* ===== SELLER REGISTER PRODUK KE FLASH SALE ===== */
/* ===== REGISTER PRODUK FLASH SALE ===== */
// Middleware untuk ambil seller_id dari cookie
function requireSeller(req, res, next) {
  const sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
  if (!sellerInfo?.id) {
    return res.status(401).json({ error: "❌ Harus login sebagai seller" });
  }
  req.seller_id = sellerInfo.id;
  next();
}

// POST register produk ke flash sale
router.post("/flash-sale/register", requireSeller, async (req, res) => {
  try {
    const { flash_sale_id, name, start_time, end_time, timezone, items } = req.body;
    const seller_id = req.seller_id;

    if (!items || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ message: "❌ items wajib diisi" });
    }

    let flashSaleId;

    // Gunakan flash sale existing jika ada
    if (flash_sale_id) {
      const { data: flashSale, error: fsErr } = await supabase
        .from("flash_sales")
        .select("*")
        .eq("id", flash_sale_id)
        .single();

      if (fsErr || !flashSale) return res.status(404).json({ message: "❌ Flash sale tidak ditemukan" });
      if (flashSale.status === "disabled") return res.status(400).json({ message: "❌ Flash sale ini sedang tidak aktif (disabled)" });

      flashSaleId = flashSale.id;
    } else {
      // Buat flash sale baru
      if (!name || !start_time || !end_time || !timezone) {
        return res.status(400).json({ message: "❌ name, start_time, end_time & timezone wajib diisi untuk flash sale baru" });
      }

      const { data: flashSale, error: createErr } = await supabase
        .from("flash_sales")
        .insert([{ name, start_time, end_time, timezone, status: "enabled" }])
        .select()
        .single();

      if (createErr || !flashSale) return res.status(500).json({ message: "❌ Gagal membuat flash sale", error: createErr });

      flashSaleId = flashSale.id;
    }

    // Ambil produk yang sudah terdaftar untuk cek duplikat
    const { data: existingProducts } = await supabase
      .from("flash_sale_products")
      .select("product_id, variant_id, flash_sale_id")
      .eq("flash_sale_id", flashSaleId);

    const existingSet = new Set(existingProducts.map(p => `${p.product_id}-${p.variant_id ?? "no-variant"}`));

    const rows = [];

    for (const item of items) {
      // Produk dengan variant
      if (item.variants && Array.isArray(item.variants) && item.variants.length > 0) {
        for (const v of item.variants) {
          if (!v.variant_id || v.stock === undefined || v.discount_percentage === undefined) {
            return res.status(400).json({ message: `❌ Variant untuk product ${item.product_id} wajib memiliki variant_id, stock & discount_percentage` });
          }

          const key = `${item.product_id}-${v.variant_id}`;
          if (existingSet.has(key)) {
            return res.status(400).json({ message: `❌ Produk ${item.product_id} (variant ${v.variant_id}) sudah terdaftar di flash sale ini` });
          }

          // Kurangi stock variant
          const { data: variant } = await supabase.from("product_variants").select("*").eq("id", v.variant_id).single();
          if (!variant) continue;

          await supabase.from("product_variants").update({ variant_stock: (variant.variant_stock || 0) - v.stock }).eq("id", v.variant_id);

          rows.push({
            seller_id,
            flash_sale_id: flashSaleId,
            product_id: item.product_id,
            variant_id: v.variant_id,
            flash_stock: v.stock,
            discount_percentage: v.discount_percentage
          });

          existingSet.add(key);
        }
      } 
      // Produk tanpa variant
      else {
        if (item.stock === undefined || item.discount_percentage === undefined) {
          return res.status(400).json({ message: `❌ Produk ${item.product_id} wajib memiliki stock & discount_percentage` });
        }

        const key = `${item.product_id}-no-variant`;
        if (existingSet.has(key)) {
          return res.status(400).json({ message: `❌ Produk ${item.product_id} sudah terdaftar di flash sale ini` });
        }

        // Kurangi stock produk
        const { data: product } = await supabase.from("products").select("*").eq("id", item.product_id).single();
        if (!product) continue;

        await supabase.from("products").update({ stock: (product.stock || 0) - item.stock }).eq("id", item.product_id);

        rows.push({
          seller_id,
          flash_sale_id: flashSaleId,
          product_id: item.product_id,
          variant_id: null,
          flash_stock: item.stock,
          discount_percentage: item.discount_percentage
        });

        existingSet.add(key);
      }
    }

    if (!rows.length) return res.status(400).json({ message: "❌ Tidak ada produk valid untuk ditambahkan" });

    const { error } = await supabase.from("flash_sale_products").insert(rows);
    if (error) return res.status(500).json({ message: "❌ Gagal daftar produk ke flash sale", error });

    return res.json({ message: "✅ Flash sale berhasil dibuat / produk didaftarkan", flash_sale_id: flashSaleId, items: rows });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

// Ambil Data Flash Sale Yang Avaible
router.get("/flash-sale/date-list", async (req, res) => {
  try {
    const now = DateTime.now().setZone("Asia/Jakarta"); // jam lokal Jakarta

    const todayStart = now.startOf("day").toISO(); // 00:00 hari ini Jakarta

    const { data: flashSales, error } = await supabase
      .from("flash_sales")
      .select("*")
      .gte("start_time", todayStart)
      .order("start_time", { ascending: true });

    if (error) {
      return res.status(500).json({ message: "❌ Gagal mengambil daftar flash sale", error });
    }

    // Fungsi tentukan sesi
    const getSession = (dateStr) => {
      const dt = DateTime.fromISO(dateStr).setZone("Asia/Jakarta");
      const hour = dt.hour;
      if (hour < 12) return "pagi";
      if (hour < 18) return "siang";
      return "malam";
    };

    // Fungsi tentukan tag waktu
    const getTag = (startStr, endStr) => {
      const start = DateTime.fromISO(startStr).setZone("Asia/Jakarta");
      const end = DateTime.fromISO(endStr).setZone("Asia/Jakarta");
      if (now >= start && now <= end) return "ongoing";
      if (now > end) return "ended";
      return "upcoming";
    };

    const grouped = {};
    flashSales.forEach((fs) => {
      const dt = DateTime.fromISO(fs.start_time).setZone("Asia/Jakarta");
      const dateKey = dt.toFormat("yyyy-MM-dd");
      const session = getSession(fs.start_time);

      if (!grouped[dateKey]) grouped[dateKey] = { pagi: [], siang: [], malam: [] };

      grouped[dateKey][session].push({
        ...fs,
        tag: getTag(fs.start_time, fs.end_time),
      });
    });

    return res.json({
      message: `✅ ${flashSales.length} flash sale ditemukan`,
      items: grouped,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "❌ Terjadi kesalahan server",
      error: err.message,
    });
  }
});

/**
 * 📌 1. List semua flash sale milik seller
 */
router.get("/flash-sale/list", requireSeller, async (req, res) => {
  try {
    const seller_id = req.seller_id;

    // Ambil semua flash_sale_id milik seller dari tabel flash_sale_products
    const { data: flashSaleProductsRaw, error: fspErr1 } = await supabase
      .from("flash_sale_products")
      .select("flash_sale_id")
      .eq("seller_id", seller_id);

    if (fspErr1) {
      return res.status(500).json({ message: "❌ Gagal ambil data flash_sale_products", error: fspErr1 });
    }

    if (!flashSaleProductsRaw.length) {
      return res.json({ message: "✅ Tidak ada flash sale", data: [] });
    }

    const flashSaleIds = [...new Set(flashSaleProductsRaw.map(p => p.flash_sale_id))];

    // Ambil detail flash_sales
    const { data: flashSales, error: fsErr } = await supabase
      .from("flash_sales")
      .select("*")
      .in("id", flashSaleIds);

    if (fsErr) {
      return res.status(500).json({ message: "❌ Gagal ambil data flash sales", error: fsErr });
    }

    // Tambahin status ongoing / berakhir
    const now = new Date();
    const result = flashSales.map(fs => {
      const start = new Date(fs.start_time);
      const end = new Date(fs.end_time);

      let tag = "upcoming";
      if (now >= start && now <= end) tag = "ongoing";
      else if (now > end) tag = "ended";

      return {
        id: fs.id,
        name: fs.name,
        start_time: fs.start_time,
        end_time: fs.end_time,
        timezone: fs.timezone,
        status: fs.status,
        tag // tambahan status waktu
      };
    });

    return res.json({ message: "✅ Daftar flash sale seller", data: result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

/**
 * 📌 2. Get detail flash sale by ID
 */
router.get("/flash-sale/:id", requireSeller, async (req, res) => {
  try {
    const seller_id = req.seller_id;
    const flashSaleId = req.params.id;

    // === Detail flash sale ===
    const { data: flashSale, error: fsErr } = await supabase
      .from("flash_sales")
      .select("*")
      .eq("id", flashSaleId)
      .single();

    if (fsErr || !flashSale) {
      return res.status(404).json({
        message: "❌ Flash sale tidak ditemukan",
        error: fsErr,
      });
    }

    // === Produk yang ikut flash sale ===
    const { data: flashSaleProducts, error: fspErr } = await supabase
      .from("flash_sale_products")
      .select("*, products(*)")
      .eq("flash_sale_id", flashSaleId)
      .eq("seller_id", seller_id);

    if (fspErr) {
      return res.status(500).json({
        message: "❌ Gagal ambil produk flash sale",
        error: fspErr,
      });
    }

    // Ambil semua produk id unik
    const productIds = [...new Set(flashSaleProducts.map((p) => p.product_id))];

    // Ambil data produk utama
    const { data: productsRaw, error: prodErr } = await supabase
      .from("products")
      .select("*")
      .in("id", productIds);

    if (prodErr) {
      return res.status(500).json({
        message: "❌ Gagal ambil produk",
        error: prodErr,
      });
    }

    // Pasang function attach discount
    const enrichedProducts = await attachVariantsStockDiscountWithRealDiscount(
      productsRaw
    );

    // Susun response produk
    const productsWithVariants = enrichedProducts.map((prod) => {
      const relatedFSP = flashSaleProducts.filter(
        (fsp) => fsp.product_id === prod.id
      );

      // === Produk tanpa varian ===
      if (!prod.variants.length) {
        return {
          product: {
            id: prod.id,
            name: prod.product_name,
          },
          variants: [],
          price_before: prod.product_price,
          discount_percentage: prod.discountPercentage,
          price_after: prod.finalPrice,
        };
      }

      // === Produk dengan varian ===
      const variants = prod.variants.map((v) => {
        const inFlashSale = relatedFSP.some((fsp) => fsp.variant_id === v.id);
        return {
          id: v.id,
          name: v.variant_name,
          in_flash_sale: inFlashSale,
          price_before: v.original_price,
          discount_percentage: inFlashSale ? v.applied_discount : 0,
          price_after: v.final_price,
        };
      });

      return {
        product: {
          id: prod.id,
          name: prod.product_name,
        },
        price_before: Math.min(...variants.map((v) => v.price_before)),
        discount_percentage: Math.max(
          ...variants.map((v) => v.discount_percentage)
        ),
        price_after: Math.min(...variants.map((v) => v.price_after)),
        variants,
      };
    });

    // === Final Response ===
    return res.json({
      message: "✅ Detail flash sale",
      data: {
        ...flashSale,
        products: productsWithVariants,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "❌ Server error",
      error: err.message,
    });
  }
});

/**
 * 📌 3. Edit flash sale (update name, waktu, timezone, status)
 */
router.put("/flash-sale/:id/products", requireSeller, async (req, res) => {
  try {
    const { id: flash_sale_id } = req.params;
    const { items } = req.body;
    const seller_id = req.seller_id;

    if (!items || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ message: "❌ items wajib diisi" });
    }

    // Ambil flash sale untuk validasi
    const { data: flashSale, error: fsErr } = await supabase
      .from("flash_sales")
      .select("*")
      .eq("id", flash_sale_id)
      .single();

    if (fsErr || !flashSale) return res.status(404).json({ message: "❌ Flash sale tidak ditemukan" });
    if (flashSale.status === "disabled") return res.status(400).json({ message: "❌ Flash sale sedang tidak aktif (disabled)" });

    // Ambil produk yang sudah ada di flash sale
    const { data: existingProducts } = await supabase
      .from("flash_sale_products")
      .select("*")
      .eq("flash_sale_id", flash_sale_id);

    const existingMap = new Map(
      existingProducts.map(p => [`${p.product_id}-${p.variant_id ?? "no-variant"}`, p])
    );

    const rowsToInsert = [];
    const rowsToUpdate = [];

    for (const item of items) {
      // kalau ada variants
      if (item.variants && Array.isArray(item.variants) && item.variants.length > 0) {
        for (const v of item.variants) {
          if (!v.variant_id || v.stock === undefined || v.discount_percentage === undefined) {
            return res.status(400).json({ message: `❌ Variant untuk product ${item.product_id} wajib ada variant_id, stock & discount_percentage` });
          }

          if (v.stock <= 0) {
            return res.status(400).json({ message: `❌ Stock untuk variant ${v.variant_id} tidak boleh 0` });
          }

          const key = `${item.product_id}-${v.variant_id}`;
          const existing = existingMap.get(key);

          if (existing) {
            // update
            rowsToUpdate.push({
              id: existing.id,
              flash_stock: v.stock,
              discount_percentage: v.discount_percentage
            });
          } else {
            // cek stok variant dulu
            const { data: variant } = await supabase.from("product_variants").select("*").eq("id", v.variant_id).single();
            if (!variant) continue;
            if ((variant.variant_stock || 0) < v.stock) {
              return res.status(400).json({ message: `❌ Stok variant ${v.variant_id} tidak mencukupi` });
            }

            // insert baru
            rowsToInsert.push({
              seller_id,
              flash_sale_id,
              product_id: item.product_id,
              variant_id: v.variant_id,
              flash_stock: v.stock,
              discount_percentage: v.discount_percentage
            });

            existingMap.set(key, true);
          }
        }
      } else {
        // tanpa variant
        if (item.stock === undefined || item.discount_percentage === undefined) {
          return res.status(400).json({ message: `❌ Produk ${item.product_id} wajib punya stock & discount_percentage` });
        }

        if (item.stock <= 0) {
          return res.status(400).json({ message: `❌ Stock untuk produk ${item.product_id} tidak boleh 0` });
        }

        const key = `${item.product_id}-no-variant`;
        const existing = existingMap.get(key);

        if (existing) {
          // update
          rowsToUpdate.push({
            id: existing.id,
            flash_stock: item.stock,
            discount_percentage: item.discount_percentage
          });
        } else {
          // cek stok produk
          const { data: product } = await supabase.from("products").select("*").eq("id", item.product_id).single();
          if (!product) continue;
          if ((product.stock || 0) < item.stock) {
            return res.status(400).json({ message: `❌ Stok produk ${item.product_id} tidak mencukupi` });
          }

          rowsToInsert.push({
            seller_id,
            flash_sale_id,
            product_id: item.product_id,
            variant_id: null,
            flash_stock: item.stock,
            discount_percentage: item.discount_percentage
          });

          existingMap.set(key, true);
        }
      }
    }

    // Jalankan insert
    if (rowsToInsert.length) {
      const { error: insertErr } = await supabase.from("flash_sale_products").insert(rowsToInsert);
      if (insertErr) return res.status(500).json({ message: "❌ Gagal menambah produk baru ke flash sale", error: insertErr });
    }

    // Jalankan update
    for (const row of rowsToUpdate) {
      const { error: updateErr } = await supabase
        .from("flash_sale_products")
        .update({
          flash_stock: row.flash_stock,
          discount_percentage: row.discount_percentage
        })
        .eq("id", row.id);

      if (updateErr) return res.status(500).json({ message: "❌ Gagal update produk flash sale", error: updateErr });
    }

    return res.json({
      message: "✅ Produk flash sale berhasil ditambahkan / diupdate",
      inserted: rowsToInsert,
      updated: rowsToUpdate
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

/**
 * 📌 4. Hapus flash sale
 * Mode:
 * - default => hapus semua produk
 * - query params products => hapus produk tertentu (non variant)
 * - query params produk dengan variant => hapus variant tertentu berdasarkan produk
 */
router.delete("/flash-sale/:id", requireSeller, async (req, res) => {
  try {
    const { id } = req.params; // flash_sale_id
    const seller_id = req.seller_id;
    const { product_id, variant_id } = req.query;

    if (!product_id) {
      // Mode hapus semua item dalam flash sale
      const { error } = await supabase
        .from("flash_sale_products")
        .delete()
        .eq("flash_sale_id", id)
        .eq("seller_id", seller_id);

      if (error) {
        return res.status(500).json({ message: "❌ Gagal hapus semua item", error: error.message });
      }

      return res.json({ message: "✅ Semua item dalam flash sale berhasil dihapus" });
    }

    // Mode hapus produk tertentu
    let query = supabase
      .from("flash_sale_products")
      .delete()
      .eq("flash_sale_id", id)
      .eq("seller_id", seller_id)
      .eq("product_id", product_id);

    if (variant_id) {
      // Mode hapus produk variant tertentu
      query = query.eq("variant_id", variant_id);
    } else {
      query = query.is("variant_id", null);
    }

    const { error } = await query;
    if (error) {
      return res
        .status(500)
        .json({ message: "❌ Gagal hapus item", error: error.message });
    }

    return res.json({
      message: `✅ Item ${product_id}${variant_id ? " varian " + variant_id : ""} berhasil dihapus`,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "❌ Server error", error: err.message });
  }
});

module.exports = router;
