const cron = require("node-cron");
const { DateTime } = require("luxon");
const supabase = require("../config/supabase");

/* ===== RESET STOK & NONAKTIFKAN FLASH SALE YANG HABIS ===== */
cron.schedule("0 * * * *", async () => {
  console.log("[CRON] Reset stok & nonaktifkan sesi habis...");
  const now = DateTime.utc().toISO();

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

  await supabase
    .from("flash_sales")
    .update({ status: "disabled" })
    .in("id", expiredIds);

  console.log(
    `🔄 Reset ${saleProducts.length} produk & nonaktifkan ${expiredIds.length} sesi flash sale`,
  );
});

/* ===== GENERATE FLASH SALE SESSION HARIAN ===== */
async function generateSessionsForDay(targetDay) {
  const isSpecialDate = targetDay.day === targetDay.month;
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
    const startTime = targetDay.set({
      hour: parseInt(s.start.split(":")[0]),
      minute: parseInt(s.start.split(":")[1]),
    });
    let endTime = targetDay.set({
      hour: parseInt(s.end.split(":")[0]),
      minute: parseInt(s.end.split(":")[1]),
    });
    if (s.end === "00:00") endTime = endTime.plus({ days: 1 });

    const { data: newSession, error } = await supabase
      .from("flash_sales")
      .insert([
        {
          name: `Flash Sale ${startTime.toFormat("dd LLL yyyy HH:mm")}`,
          start_time: startTime.toUTC().toISO(),
          end_time: endTime.toUTC().toISO(),
          status: "active",
        },
      ])
      .select()
      .single();
    if (error) {
      console.error("❌ Gagal buat sesi:", error);
      continue;
    }

    await supabase.from("flash_sale_products").insert([
      {
        flash_sale_id: newSession.id,
        product_id: 1,
        discount_percentage: 20,
        flash_stock: 50,
      },
    ]);
  }
}

/* ===== INIT: CEK TERAKHIR GENERATE 1 BULAN ===== */
(async () => {
  console.log("[INIT] Cek apakah perlu generate sesi 1 bulan...");
  const { data: flag } = await supabase
    .from("system_flags")
    .select("*")
    .eq("key", "last_flashsale_generate")
    .single();

  const now = DateTime.now().setZone("Asia/Jakarta");
  let needGenerate = true;

  if (flag && flag.value) {
    const lastGenerated = DateTime.fromISO(flag.value);
    const diff = now.diff(lastGenerated, "days").toObject().days;
    if (diff < 30) {
      needGenerate = false;
      console.log("⏩ Sudah generate dalam 30 hari terakhir, skip...");
    }
  }

  if (needGenerate) {
    console.log("⚡ Generate sesi flash sale 1 bulan ke depan...");
    for (let i = 0; i < 30; i++) {
      const targetDay = now.plus({ days: i });
      await generateSessionsForDay(targetDay);
    }

    // Simpan waktu terakhir generate
    await supabase
      .from("system_flags")
      .upsert({ key: "last_flashsale_generate", value: now.toISO() });
  }
})();

module.exports = { generateSessionsForDay };
