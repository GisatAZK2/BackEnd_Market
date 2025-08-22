const cron = require("node-cron");
const supabase = require("../config/supabase");

// Cron job: jalan tiap jam
cron.schedule("0 * * * *", async () => {
  console.log("⏰ Cron running: auto delete orders after rating_deadline");

  try {
    const now = new Date().toISOString();

    // Ambil order yang sudah lewat deadline
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

    // Hapus order
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
