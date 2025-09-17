const cron = require("node-cron");
const supabase = require("../config/supabase");
const axios = require("axios");

const SEND_URL = process.env.SEND_SERVICE_URL;


// Helper DB wallet operations for sellers
async function getSellerBalance(sellerId) {
  const { data, error } = await supabase
    .from("seller_balances")
    .select("balance")
    .eq("seller_id", sellerId)
    .single();

  if (error && error.code === "PGRST116") {
    return 0;
  }
  if (error) throw error;
  return Number(data?.balance ?? 0);
}

async function upsertSellerBalance(sellerId, newBalance) {
  const { data, error } = await supabase
    .from("seller_balances")
    .upsert({ seller_id: sellerId, balance: newBalance }, { onConflict: "seller_id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function recordSellerTransaction({ sellerId, amount, type, orderId = null, metadata = {} }) {
  const timestamp = DateTime.now().toISO();
  const payloadToSign = { sellerId, amount, type, orderId, metadata, timestamp };
  const signature = signPayload(payloadToSign);

  const insertObj = {
    seller_id: sellerId,
    amount,
    type,
    order_id: orderId,
    timestamp,
    signature,
    metadata,
  };

  const { data, error } = await supabase
    .from("seller_balance_transactions")
    .insert([insertObj])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function mintSellerBalance(sellerId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getSellerBalance(sellerId);
  const newBalance = Number(current) + Number(amount);
  await upsertSellerBalance(sellerId, newBalance);
  await recordSellerTransaction({
    sellerId,
    amount,
    type: "credit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
}

async function withdrawSellerBalance(sellerId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getSellerBalance(sellerId);
  if (Number(current) < Number(amount)) {
    throw new Error("Insufficient funds");
  }
  const newBalance = Number(current) - Number(amount);
  await upsertSellerBalance(sellerId, newBalance);
  await recordSellerTransaction({
    sellerId,
    amount,
    type: "debit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
}

// Helper DB wallet operations for users
async function getUserBalance(userId) {
  const { data, error } = await supabase
    .from("user_balances")
    .select("balance")
    .eq("user_id", userId)
    .single();

  if (error && error.code === "PGRST116") {
    return 0;
  }
  if (error) throw error;
  return Number(data?.balance ?? 0);
}

async function upsertUserBalance(userId, newBalance) {
  const { data, error } = await supabase
    .from("user_balances")
    .upsert({ user_id: userId, balance: newBalance }, { onConflict: "user_id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function recordUserTransaction({ userId, amount, type, orderId = null, metadata = {} }) {
  const timestamp = DateTime.now().toISO();
  const payloadToSign = { userId, amount, type, orderId, metadata, timestamp };
  const signature = signPayload(payloadToSign);

  const insertObj = {
    user_id: userId,
    amount,
    type,
    order_id: orderId,
    timestamp,
    signature,
    metadata,
  };

  const { data, error } = await supabase
    .from("user_balance_transactions")
    .insert([insertObj])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function mintUserBalance(userId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getUserBalance(userId);
  const newBalance = Number(current) + Number(amount);
  await upsertUserBalance(userId, newBalance);
  await recordUserTransaction({
    userId,
    amount,
    type: "credit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
}

async function withdrawUserBalance(userId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getUserBalance(userId);
  if (Number(current) < Number(amount)) {
    throw new Error("Insufficient funds");
  }
  const newBalance = Number(current) - Number(amount);
  await upsertUserBalance(userId, newBalance);
  await recordUserTransaction({
    userId,
    amount,
    type: "debit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
}


const buildProductDetails = (items, products, variants) =>
  items.map((item) => {
    const product = products?.find((p) => p.id === item.product_id);
    const variant = variants?.find((v) => v.id === item.variant_id);
    return {
      product_name: product?.product_name,
      variant_name: variant?.variant_name || null,
      quantity: item.quantity,
      total_price: item.price_per_item * item.quantity,
      product_image_url:
        variant?.variant_image_url ||
        JSON.parse(product?.product_image_url || "[]")[0] ||
        null,
    };
  });

const restoreStock = async (orderItems) => {
  for (const item of orderItems) {
    if (item.variant_id) {
      // Restore stock to product_variants
      const { data: variant, error: variantError } = await supabase
        .from("product_variants")
        .select("variant_stock")
        .eq("id", item.variant_id)
        .single();

      if (variantError || !variant) {
        console.error(`❌ Failed to fetch variant ${item.variant_id}:`, variantError?.message);
        throw new Error("Failed to fetch variant for stock restoration");
      }

      const newStock = (variant.variant_stock || 0) + item.quantity;
      const { error: updateError } = await supabase
        .from("product_variants")
        .update({ variant_stock: newStock })
        .eq("id", item.variant_id);

      if (updateError) {
        console.error(`❌ Failed to restore stock for variant ${item.variant_id}:`, updateError.message);
        throw new Error("Failed to restore variant stock");
      }
      console.log(`✅ Restored ${item.quantity} to variant ${item.variant_id} stock`);
    } else {
      // Restore stock to products
      const { data: product, error: productError } = await supabase
        .from("products")
        .select("stock")
        .eq("id", item.product_id)
        .single();

      if (productError || !product) {
        console.error(`❌ Failed to fetch product ${item.product_id}:`, productError?.message);
        throw new Error("Failed to fetch product for stock restoration");
      }

      const newStock = (product.stock || 0) + item.quantity;
      const { error: updateError } = await supabase
        .from("products")
        .update({ stock: newStock })
        .eq("id", item.product_id);

      if (updateError) {
        console.error(`❌ Failed to restore stock for product ${item.product_id}:`, updateError.message);
        throw new Error("Failed to restore product stock");
      }
      console.log(`✅ Restored ${item.quantity} to product ${item.product_id} stock`);
    }
  }
};

// Helper untuk auto cancel + kirim notifikasi
const autoCancelOrders = async (orders, reason) => {
  if (!orders?.length) return 0;

  const orderIds = orders.map((o) => o.id);

  const { data: updated, error: cancelErr } = await supabase
    .from("orders")
    .update({
      status: "dibatalkan",
      cancel_reason: reason,
      refund_requested: (order) => order.payment_status === "paid",
    })
    .in("id", orderIds)
    .select(`
      id, pickup_method, total_price, payment_status, buyer:users(id, email, username),
      seller:sellers(id, email),
      order_items(id, quantity, price_per_item, product_id, variant_id)
    `);

  if (cancelErr) {
    console.error("❌ Gagal auto-cancel:", cancelErr);
    return 0;
  }

  // Process refunds and stock restoration for each canceled order
  for (const order of updated) {
    try {
      // Restore stock
      await restoreStock(order.order_items);
      console.log(`✅ Stock restored for order ${order.id}`);

      // Handle refund if paid
      if (order.payment_status === "paid") {
        const grossAmount = Number(order.total_price ?? 0);
        const platformFee = 0; // Sesuaikan jika ada fee
        const netAmount = grossAmount - platformFee;

        if (netAmount <= 0) {
          console.warn(`⚠️ Net amount for refund is 0 or negative for order ${order.id}. Skipping refund.`);
        } else {
          try {
            // Debit dari seller balance
            await withdrawSellerBalance(order.seller.id, netAmount, {
              orderId: order.id,
              metadata: { source: "auto_cancel_refund_debit" },
            });
            console.log(`✅ Debited seller ${order.seller.id} amount ${netAmount}`);

            // Credit ke user balance
            await mintUserBalance(order.buyer.id, netAmount, {
              orderId: order.id,
              metadata: { source: "auto_cancel_refund_credit" },
            });
            console.log(`✅ Credited user ${order.buyer.id} amount ${netAmount}`);

            // Update order refund status
            await supabase
              .from("orders")
              .update({
                refund_status: "completed",
                refunded_at: new Date().toISOString(),
                refund_requested: false,
              })
              .eq("id", order.id);
            console.log(`✅ Updated refund status for order ${order.id}`);
          } catch (refundErr) {
            console.error(`❌ Refund failed for order ${order.id}:`, refundErr.message);
            await supabase
              .from("orders")
              .update({
                refund_status: "failed",
                refund_requested: true,
              })
              .eq("id", order.id);
          }
        }
      }

      // Fetch product details for notification
      const productIds = [...new Set(order.order_items.map((i) => i.product_id))];
      const variantIds = order.order_items.map((i) => i.variant_id).filter(Boolean);

      const [{ data: products }, { data: variants }] = await Promise.all([
        supabase
          .from("products")
          .select("id, product_name, product_image_url")
          .in("id", productIds),
        supabase
          .from("product_variants")
          .select("id, variant_name, variant_image_url")
          .in("id", variantIds),
      ]);

      const productDetails = buildProductDetails(order.order_items, products, variants);

      // Kirim email ke SMTP microservice (non-blocking)
      axios
        .post(`${SEND_URL}/send-email-order`, {
          order_id: order.id,
          products: productDetails,
          buyer_email: order.buyer?.email,
          seller_email: order.seller?.email,
          buyer_username: order.buyer?.username,
          pickup_method: order.pickup_method,
          new_status: "dibatalkan",
          cancel_reason: reason,
          ...(order.refund_status === "completed" && {
            refund_amount: order.total_price,
            refund_status: "completed",
          }),
        })
        .catch((err) => {
          console.error(`❌ Gagal kirim notifikasi auto-cancel order ${order.id}:`, err.message);
        });
    } catch (notifyErr) {
      console.error(`❌ Error saat siapkan notifikasi order ${order.id}:`, notifyErr);
    }
  }

  return orders.length;
};

// === Jalankan tiap 1 menit ===
cron.schedule("*/1 * * * *", async () => {
  try {
    const now = new Date().toISOString();
    let canceledCount = 0;

    // === Order menunggu konfirmasi seller ===
    const { data: expiredUnconfirmed } = await supabase
      .from("orders")
      .select("id, pickup_method, total_price, payment_status, buyer:users(id), seller:sellers(id), order_items(id, quantity, price_per_item, product_id, variant_id)")
      .eq("status", "pending")
      .in("pickup_method", ["diantar", "diambil"])
      .lt("confirm_deadline", now);

    canceledCount += await autoCancelOrders(
      expiredUnconfirmed,
      "❌ Batal otomatis karena seller tidak menerima order dalam batas waktu."
    );

    // === Pickup expired ===
    const { data: expiredPickup } = await supabase
      .from("orders")
      .select("id, pickup_method, total_price, payment_status, buyer:users(id), seller:sellers(id), order_items(id, quantity, price_per_item, product_id, variant_id)")
      .eq("status", "siap di ambil")
      .lt("pickup_deadline", now);

    canceledCount += await autoCancelOrders(
      expiredPickup,
      "❌ Batal otomatis karena melewati batas waktu pengambilan."
    );

    // === Delivery expired ===
    const { data: expiredDelivery } = await supabase
      .from("orders")
      .select("id, pickup_method, total_price, payment_status, buyer:users(id), seller:sellers(id), order_items(id, quantity, price_per_item, product_id, variant_id)")
      .eq("status", "sedang di antar")
      .lt("delivery_deadline", now);

    canceledCount += await autoCancelOrders(
      expiredDelivery,
      "❌ Batal otomatis karena melewati batas waktu pengiriman."
    );

    if (canceledCount === 0) {
      console.log("ℹ️ Tidak ada pesanan yang dibatalkan.");
    } else {
      console.log(`⚡ Auto-cancel total ${canceledCount} pesanan.`);
    }
  } catch (err) {
    console.error("❌ Auto-cancel job error:", err);
  }
});