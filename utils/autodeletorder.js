const cron = require("node-cron");
const supabase = require("../config/supabase");

// Cron job: jalan tiap jam
cron.schedule("0 * * * *", async () => {
  console.log("⏰ Cron running: auto delete orders after rating_deadline or canceled");

  try {
    const now = new Date();

    // ----- Hapus order expired rating_deadline -----
    const { data: expiredOrders, error: expiredError } = await supabase
      .from("orders")
      .select("id")
      .lt("rating_deadline", now.toISOString())
      .eq("status", "diterima oleh pembeli");

    if (expiredError) {
      console.error("❌ Error fetch expired orders:", expiredError);
      return;
    }

    if (expiredOrders && expiredOrders.length > 0) {
      const expiredIds = expiredOrders.map((o) => o.id);

      await supabase.from("order_items").delete().in("order_id", expiredIds);
      await supabase.from("orders").delete().in("id", expiredIds);

      console.log(`🗑️ ${expiredIds.length} order expired berhasil dihapus.`);
    } else {
      console.log("✅ Tidak ada order expired rating_deadline.");
    }

    // ----- Hapus order dibatalkan (langsung) -----
    const { data: canceledOrders, error: canceledError } = await supabase
      .from("orders")
      .select("id")
      .eq("status", "dibatalkan");

    if (canceledError) {
      console.error("❌ Error fetch canceled orders:", canceledError);
      return;
    }

    if (canceledOrders && canceledOrders.length > 0) {
      const canceledIds = canceledOrders.map((o) => o.id);

      await supabase.from("order_items").delete().in("order_id", canceledIds);
      await supabase.from("orders").delete().in("id", canceledIds);

      console.log(`🗑️ ${canceledIds.length} order dibatalkan berhasil dihapus.`);
    } else {
      console.log("✅ Tidak ada order dibatalkan.");
    }

  } catch (err) {
    console.error("❌ Cron job error:", err.message);
  }
});
