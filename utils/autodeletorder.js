const cron = require("node-cron");
const supabase = require("../config/supabase");

// Cron job: jalan tiap jam
cron.schedule("0 * * * *", async () => {
  console.log("⏰ Cron running: auto delete orders after rating_deadline");

  try {
    const now = new Date().toISOString();

    // Ambil order yang sudah lewat deadline & status "diterima oleh pembeli"
    const { data: expiredOrders, error } = await supabase
      .from("orders")
      .select("id")
      .lt("rating_deadline", now)
      .eq("status", "diterima oleh pembeli");

    if (error) {
      console.error("❌ Error fetch expired orders:", error);
      return;
    }

    if (!expiredOrders || expiredOrders.length === 0) {
      console.log("✅ Tidak ada order yang expired.");
      return;
    }

    const expiredIds = expiredOrders.map((o) => o.id);

    // Hapus order_items dulu supaya FK ratings tetap aman
    const { error: itemsError } = await supabase
      .from("order_items")
      .delete()
      .in("order_id", expiredIds);

    if (itemsError) {
      console.error("❌ Error delete order_items of expired orders:", itemsError);
      return;
    }

    // Hapus orders
    const { error: delError } = await supabase
      .from("orders")
      .delete()
      .in("id", expiredIds);

    if (delError) {
      console.error("❌ Error delete expired orders:", delError);
      return;
    }

    console.log(`🗑️ ${expiredIds.length} order expired berhasil dihapus.`);
  } catch (err) {
    console.error("❌ Cron job error:", err.message);
  }
});
