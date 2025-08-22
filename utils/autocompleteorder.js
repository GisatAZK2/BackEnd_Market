const cron = require("node-cron");
const supabase = require("../config/supabase");

// Cron tiap 10 menit
cron.schedule("*/10 * * * *", async () => {
  console.log("⏳ Jalankan auto confirm orders...");
  try {
    const { data: expiredOrders, error } = await supabase
      .from("orders")
      .select("id, status, confirm_by_buyers_deadline")
      .eq("status", "diterima")
      .lte("confirm_by_buyers_deadline", new Date().toISOString());

    if (error) {
      console.error("❌ Gagal ambil expired orders:", error.message);
      return;
    }

    if (!expiredOrders.length) return;

    for (const order of expiredOrders) {
      const ratingDeadline = new Date();
      ratingDeadline.setDate(ratingDeadline.getDate() + 1);

      const { error: updateError } = await supabase
        .from("orders")
        .update({
          status: "diterima oleh pembeli",
          rating_deadline: ratingDeadline.toISOString(),
        })
        .eq("id", order.id);

      if (updateError) {
        console.error(`⚠ Gagal auto confirm order ${order.id}:`, updateError.message);
      } else {
        console.log(`✅ Order ${order.id} auto confirmed jadi 'diterima oleh pembeli'`);
      }
    }
  } catch (err) {
    console.error("❌ Cron error:", err.message);
  }
});
