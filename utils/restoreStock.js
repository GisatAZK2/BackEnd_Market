const cron = require("node-cron");
const supabase = require("../config/supabase");
const { DateTime } = require("luxon");

async function restoreEventStock() {
  const now = DateTime.utc().toISO();

  // === Ambil event yang sudah selesai ===
  const { data: finishedEvents } = await supabase
    .from("events")
    .select("id")
    .lt("end_time", now);

  if (!finishedEvents?.length) return;

  for (const event of finishedEvents) {
    // Ambil semua produk event
    const { data: eventProducts } = await supabase
      .from("event_products")
      .select("product_id,event_stock")
      .eq("event_id", event.id);

    for (const ep of eventProducts) {
      // Kembalikan stok
      await supabase.rpc("increment_stock", {
        product_id_input: ep.product_id,
        qty: ep.event_stock,
      });
    }

    // Hapus data stok event
    await supabase.from("event_products").delete().eq("event_id", event.id);
  }
}

async function restoreFlashSaleStock() {
  const now = DateTime.utc().toISO();

  // === Ambil flash sale yang sudah selesai ===
  const { data: finishedFlashSales } = await supabase
    .from("flash_sales")
    .select("id,product_id,flash_stock")
    .lt("end_time", now);

  if (!finishedFlashSales?.length) return;

  for (const fs of finishedFlashSales) {
    // Kembalikan stok
    await supabase.rpc("increment_stock", {
      product_id_input: fs.product_id,
      qty: fs.flash_stock,
    });

    // Hapus data flash sale
    await supabase.from("flash_sales").delete().eq("id", fs.id);
  }
}

function startCronJobs() {
  // Jalan setiap 1 menit
  cron.schedule("* * * * *", async () => {
    try {
      console.log("[CRON] Restore stock job running...");
      await restoreEventStock();
      await restoreFlashSaleStock();
      console.log("[CRON] Restore stock job done");
    } catch (err) {
      console.error("[CRON ERROR]", err.message);
    }
  });
}

module.exports = startCronJobs;
