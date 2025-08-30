const cron = require("node-cron");
const { DateTime } = require("luxon");
const supabase = require("../config/supabase");

/* ===== RESET STOK & NONAKTIFKAN FLASH SALE YANG HABIS ===== */
cron.schedule("0 * * * *", async () => {
  console.log("[CRON] Cek & nonaktifkan flash sale expired...");
  const now = DateTime.now().setZone("Asia/Jakarta").toISO();

  const { data: expiredSessions, error: expiredErr } = await supabase
    .from("flash_sales")
    .select("id")
    .lt("end_time", now)
    .eq("status", "active");

  if (expiredErr) {
    console.error("❌ Gagal ambil sesi flash sale:", expiredErr);
    return;
  }

  if (!expiredSessions?.length) {
    console.log("ℹ️ Tidak ada sesi flash sale yang expired.");
    return;
  }

  const expiredIds = expiredSessions.map((s) => s.id);

  // Ambil semua produk dari sesi expired
  const { data: expiredProducts, error: prodErr } = await supabase
    .from("flash_sale_products")
    .select("product_id, variant_id, flash_stock")
    .in("flash_sale_id", expiredIds);

  if (prodErr) {
    console.error("❌ Gagal ambil produk flash sale:", prodErr);
    return;
  }

  // Balikin stok ke produk utama atau variant
  for (const p of expiredProducts) {
    try {
      if (p.variant_id) {
        // Produk variant
        const { error: vErr } = await supabase.rpc("increment_variant_stock", {
          p_variant_id: p.variant_id,
          qty: p.flash_stock,
        });
        if (vErr) throw vErr;
      } else {
        // Produk biasa
        const { error: pErr } = await supabase.rpc("increment_stock", {
          p_id: p.product_id,
          qty: p.flash_stock,
        });
        if (pErr) throw pErr;
      }
    } catch (err) {
      console.error("❌ Gagal kembalikan stok:", err);
    }
  }

  // Hapus produk dari flash sale expired
  const { error: delErr } = await supabase
    .from("flash_sale_products")
    .delete()
    .in("flash_sale_id", expiredIds);

  if (delErr) {
    console.error("❌ Gagal hapus produk dari flash sale:", delErr);
    return;
  }

  // Nonaktifkan sesi flash sale
  const { error: disableErr } = await supabase
    .from("flash_sales")
    .update({ status: "disabled" })
    .in("id", expiredIds);

  if (disableErr) {
    console.error("❌ Gagal nonaktifkan sesi:", disableErr);
    return;
  }

  console.log(`🔄 Nonaktifkan ${expiredIds.length} sesi & kembalikan stok produk/varian.`);
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
