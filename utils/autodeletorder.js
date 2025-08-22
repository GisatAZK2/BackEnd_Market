const cron = require("node-cron");

// Cron job setiap 1 jam
cron.schedule("0 * * * *", async () => {
  try {
    console.log("🔄 Cron job: cek order expired / auto-delete");

    // Ambil order yang sudah expired misal status 'pending' lebih dari 7 hari
    const { data: expiredOrders, error } = await supabase
      .from("orders")
      .select("id")
      .lt("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()); // 7 hari lalu

    if (error) {
      console.error("❌ Cron error ambil expired orders:", error);
      return;
    }

    if (!expiredOrders?.length) {
      console.log("✅ Tidak ada order expired.");
      return;
    }

    const orderIds = expiredOrders.map((o) => o.id);

    // Hapus order tapi jangan hapus rating (rating aman karena foreign key ON DELETE SET NULL)
    const { error: delError } = await supabase
      .from("orders")
      .delete()
      .in("id", orderIds);

    if (delError) {
      console.error("❌ Cron gagal hapus orders:", delError);
    } else {
      console.log(`✅ Cron berhasil hapus ${orderIds.length} order(s).`);
    }
  } catch (err) {
    console.error("❌ Cron server error:", err);
  }
});
