const cron = require("node-cron");
const supabase = require("../config/supabase");
const axios = require("axios");
const { DateTime } = require("luxon");
const crypto = require("crypto");

const SEND_URL = process.env.SEND_SERVICE_URL;

function signPayload(payload) {
  const str = JSON.stringify(payload);
  return crypto.createHash("sha256").update(str).digest("hex");
}

// ======= Wallet Helpers ======= //
async function getSellerBalance(sellerId) {
  const { data, error } = await supabase
    .from("seller_balances")
    .select("balance, withdrawable_balance") // Modified: Include withdrawable_balance
    .eq("seller_id", sellerId)
    .single();
  if (error && error.code === "PGRST116") return { balance: 0, withdrawable_balance: 0 };
  if (error) throw error;
  return {
    balance: Number(data?.balance ?? 0),
    withdrawable_balance: Number(data?.withdrawable_balance ?? 0),
  };
}

async function upsertSellerBalance(sellerId, newBalance, newWithdrawableBalance) {
  // Modified: Include withdrawable_balance
  const { data, error } = await supabase
    .from("seller_balances")
    .upsert(
      {
        seller_id: sellerId,
        balance: newBalance,
        withdrawable_balance: newWithdrawableBalance,
      },
      { onConflict: "seller_id" }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function recordSellerTransaction({ sellerId, amount, type, orderId = null, metadata = {} }) {
  const timestamp = DateTime.now().toISO();
  const signature = signPayload({ sellerId, amount, type, orderId, metadata, timestamp });
  const { data, error } = await supabase
    .from("seller_balance_transactions")
    .insert([
      {
        seller_id: sellerId,
        amount,
        type,
        order_id: orderId,
        timestamp,
        signature,
        metadata,
      },
    ])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function withdrawSellerBalance(sellerId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getSellerBalance(sellerId);
  if (current.balance < Number(amount)) throw new Error("Insufficient funds");
  const newBalance = current.balance - Number(amount);
  const newWithdrawableBalance = current.withdrawable_balance - Number(amount);
  await upsertSellerBalance(sellerId, newBalance, newWithdrawableBalance);
  await recordSellerTransaction({
    sellerId,
    amount,
    type: "debit",
    orderId: opts.orderId || null,
    metadata: opts.metadata || {},
  });
  return newBalance;
}

// ======= User Wallet Helpers ======= //
async function getUserBalance(userId) {
  const { data, error } = await supabase.from("user_balances").select("balance").eq("user_id", userId).single();
  if (error && error.code === "PGRST116") return 0;
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
  const signature = signPayload({ userId, amount, type, orderId, metadata, timestamp });
  const { data, error } = await supabase
    .from("user_balance_transactions")
    .insert([
      {
        user_id: userId,
        amount,
        type,
        order_id: orderId,
        timestamp,
        signature,
        metadata,
      },
    ])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function mintUserBalance(userId, amount, opts = {}) {
  if (amount <= 0) throw new Error("Amount harus > 0");
  const current = await getUserBalance(userId);
  const newBalance = current + Number(amount);
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

// ======= Helper Aman JSON ======= //
function safeParseJSON(str, fallback = []) {
  if (!str) return fallback;
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return [str];
  }
}

const buildProductDetails = (items, products, variants) =>
  items.map((item) => {
    const product = products?.find((p) => p.id === item.product_id);
    const variant = variants?.find((v) => v.id === item.variant_id);
    const productImageUrl =
      variant?.variant_image_url ||
      safeParseJSON(product?.product_image_url)[0] ||
      product?.product_image_url ||
      null;
    return {
      product_name: product?.product_name || "Unknown Product",
      variant_name: variant?.variant_name || null,
      quantity: item.quantity,
      total_price: item.price_per_item * item.quantity,
      product_image_url: productImageUrl,
      discount_source: item.discount_source, // Added
    };
  });

// ======= Restore Stock ======= //
const restoreStock = async (orderItems) => {
  const now = DateTime.utc();

  for (const item of orderItems) {
    // Modified: Restore stock based on discount_source
    const { discount_source, quantity, product_id, variant_id } = item;

    // Check discount validity if applicable
    const isDiscountActive = async (source, productId, variantId) => {
      if (source === "normal") return false;

      if (source === "flash") {
        const { data: flashSaleProduct } = await supabase
          .from("flash_sale_products")
          .select("flash_sale_id, flash_stock")
          .eq("product_id", productId)
          .eq("variant_id", variantId || null)
          .single();

        if (!flashSaleProduct) return false;

        const { data: flashSale } = await supabase
          .from("flash_sales")
          .select("start_time, end_time, status")
          .eq("id", flashSaleProduct.flash_sale_id)
          .single();

        if (!flashSale) return false;

        const start = DateTime.fromISO(flashSale.start_time).toUTC();
        const end = DateTime.fromISO(flashSale.end_time).toUTC();
        return (
          flashSale.status === "active" &&
          start <= now &&
          end >= now &&
          flashSaleProduct.flash_stock !== null &&
          flashSaleProduct.flash_stock >= 0
        );
      }

      if (source === "event") {
        const { data: eventProduct } = await supabase
          .from("event_products")
          .select("event_id, event_stock")
          .eq("product_id", productId)
          .eq("variant_id", variantId || null)
          .single();

        if (!eventProduct) return false;

        const { data: event } = await supabase
          .from("events")
          .select("start_time, end_time")
          .eq("id", eventProduct.event_id)
          .single();

        if (!event) return false;

        const start = DateTime.fromISO(event.start_time).toUTC();
        const end = DateTime.fromISO(event.end_time).toUTC();
        return (
          start <= now &&
          end >= now &&
          eventProduct.event_stock !== null &&
          eventProduct.event_stock >= 0
        );
      }

      if (source === "store") {
        const { data: storeDiscountItem } = await supabase
          .from("store_discount_items")
          .select("discount_id, stock")
          .eq("product_id", productId)
          .eq("variant_id", variantId || null)
          .single();

        if (!storeDiscountItem) return false;

        const { data: storeDiscount } = await supabase
          .from("store_discounts")
          .select("start_time, end_time")
          .eq("id", storeDiscountItem.discount_id)
          .single();

        if (!storeDiscount) return false;

        const start = DateTime.fromISO(storeDiscount.start_time).toUTC();
        const end = DateTime.fromISO(storeDiscount.end_time).toUTC();
        return (
          start <= now &&
          end >= now &&
          storeDiscountItem.stock !== null &&
          storeDiscountItem.stock >= 0
        );
      }

      return false;
    };

    const discountActive = await isDiscountActive(discount_source, product_id, variant_id);

    if (discountActive) {
      // Restore to discount stock if still active
      if (discount_source === "flash") {
        const { error } = await supabase
          .from("flash_sale_products")
          .update({ flash_stock: supabase.raw(`flash_stock + ${quantity}`) })
          .eq("product_id", product_id)
          .eq("variant_id", variant_id || null);
        if (error) throw new Error(`Failed to restore flash sale stock: ${error.message}`);
        console.log(`✅ Restored ${quantity} to flash sale stock for product ${product_id}, variant ${variant_id || 'none'}`);
      } else if (discount_source === "event") {
        const { error } = await supabase
          .from("event_products")
          .update({ event_stock: supabase.raw(`event_stock + ${quantity}`) })
          .eq("product_id", product_id)
          .eq("variant_id", variant_id || null);
        if (error) throw new Error(`Failed to restore event stock: ${error.message}`);
        console.log(`✅ Restored ${quantity} to event stock for product ${product_id}, variant ${variant_id || 'none'}`);
      } else if (discount_source === "store") {
        const { error } = await supabase
          .from("store_discount_items")
          .update({ stock: supabase.raw(`stock + ${quantity}`) })
          .eq("product_id", product_id)
          .eq("variant_id", variant_id || null);
        if (error) throw new Error(`Failed to restore store discount stock: ${error.message}`);
        console.log(`✅ Restored ${quantity} to store discount stock for product ${product_id}, variant ${variant_id || 'none'}`);
      }
    } else {
      // Restore to normal stock if discount is not active or source is normal
      if (variant_id) {
        const { data: variant, error } = await supabase
          .from("product_variants")
          .select("variant_stock")
          .eq("id", variant_id)
          .single();
        if (error || !variant) throw new Error("Failed to fetch variant for stock restoration");
        const newStock = (variant.variant_stock || 0) + quantity;
        const { error: updateErr } = await supabase
          .from("product_variants")
          .update({ variant_stock: newStock })
          .eq("id", variant_id);
        if (updateErr) throw new Error("Failed to restore variant stock");
        console.log(`✅ Restored ${quantity} to variant stock ${variant_id}`);
      } else {
        const { data: product, error } = await supabase
          .from("products")
          .select("stock")
          .eq("id", product_id)
          .single();
        if (error || !product) throw new Error("Failed to fetch product for stock restoration");
        const newStock = (product.stock || 0) + quantity;
        const { error: updateErr } = await supabase
          .from("products")
          .update({ stock: newStock })
          .eq("id", product_id);
        if (updateErr) throw new Error("Failed to restore product stock");
        console.log(`✅ Restored ${quantity} to product stock ${product_id}`);
      }
    }
  }
};

// ======= System Flags Helpers ======= //
async function getSystemFlag(key) {
  const { data, error } = await supabase.from("system_flags").select("value").eq("key", key).single();
  if (error && error.code === "PGRST116") return null;
  if (error) throw error;
  return data?.value ?? null;
}

async function setSystemFlag(key, value) {
  const { data, error } = await supabase
    .from("system_flags")
    .upsert({ key, value }, { onConflict: "key" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ======= Auto Cancel Orders ======= //
const autoCancelOrders = async (orders, reason) => {
  if (!orders?.length) return 0;

  // cek apakah datanya sama dengan terakhir
  const lastHash = await getSystemFlag("last_auto_cancel_hash");
  const currentHash = signPayload(orders.map((o) => o.id).sort());

  if (lastHash === currentHash) {
    console.log("⚡ Data sama dengan sebelumnya, skip auto-cancel");
    return 0;
  }

  // simpan hash terbaru
  await setSystemFlag("last_auto_cancel_hash", currentHash);

  const orderIds = orders.map((o) => o.id);

  const { data: updated, error } = await supabase
    .from("orders")
    .update({
      status: "dibatalkan",
      cancel_reason: reason,
      refund_requested: (order) => order.payment_status === "paid",
    })
    .in("id", orderIds)
    .select(
      `id, pickup_method, total_price, payment_status, payment_method, status, buyer:users(id, email, username), seller:sellers(id, email), order_items(id, quantity, price_per_item, product_id, variant_id, discount_source)`
    );

  if (error) {
    console.error("❌ Gagal auto-cancel:", error);
    return 0;
  }

  for (const order of updated) {
    try {
      await restoreStock(order.order_items);

      if (order.payment_status === "paid") {
        const netAmount = Number(order.total_price || 0);
        await mintUserBalance(order.buyer.id, netAmount, {
          orderId: order.id,
          metadata: { source: "auto_cancel_refund" },
        });

        if (order.payment_method === "balance") {
          try {
            await withdrawSellerBalance(order.seller.id, netAmount, {
              orderId: order.id,
              metadata: { source: "auto_cancel_refund_debit" },
            });
          } catch (err) {
            console.error(`❌ Failed debit seller balance for order ${order.id}:`, err.message);
          }
        }

        await supabase
          .from("orders")
          .update({
            refund_status: "completed",
            refunded_at: new Date().toISOString(),
            refund_requested: false,
          })
          .eq("id", order.id);
      }

      const productIds = [...new Set(order.order_items.map((i) => i.product_id))];
      const variantIds = order.order_items
        .map((i) => i.variant_id)
        .filter(Boolean);

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
          ...(order.payment_status === "paid" && {
            refund_amount: order.total_price,
            refund_status: "completed",
          }),
        })
        .catch((err) =>
          console.error(
            `❌ Failed to send email for order ${order.id}:`,
            err.message
          )
        );
    } catch (err) {
      console.error(`❌ Error processing order ${order.id}:`, err.message);
    }
  }

  return orders.length;
};

// ======= Cron JobResources ======= //
cron.schedule("*/1 * * * *", async () => {
  try {
    const now = new Date().toISOString();
    let canceledCount = 0;

    const { data: expiredUnconfirmed } = await supabase
      .from("orders")
      .select(
        "id, status, payment_method, payment_status, total_price, pickup_method, buyer:users(id), seller:sellers(id), order_items(id, quantity, price_per_item, product_id, variant_id, discount_source)"
      )
      .in("status", ["pending", "processing"])
      .lt("confirm_deadline", now);

    canceledCount += await autoCancelOrders(
      expiredUnconfirmed,
      "❌ Batal otomatis karena seller tidak menerima order dalam batas waktu."
    );

    const { data: expiredPickup } = await supabase
      .from("orders")
      .select(
        "id, status, payment_method, payment_status, total_price, pickup_method, buyer:users(id), seller:sellers(id), order_items(id, quantity, price_per_item, product_id, variant_id, discount_source)"
      )
      .eq("status", "siap di ambil")
      .lt("pickup_deadline", now);

    canceledCount += await autoCancelOrders(
      expiredPickup,
      "❌ Batal otomatis karena melewati batas waktu pengambilan."
    );

    const { data: expiredDelivery } = await supabase
      .from("orders")
      .select(
        "id, status, payment_method, payment_status, total_price, pickup_method, buyer:users(id), seller:sellers(id), order_items(id, quantity, price_per_item, product_id, variant_id, discount_source)"
      )
      .eq("status", "sedang di antar")
      .lt("delivery_deadline", now);

    canceledCount += await autoCancelOrders(
      expiredDelivery,
      "❌ Batal otomatis karena melewati batas waktu pengiriman."
    );

    const { data: expiredPayments } = await supabase
      .from("orders")
      .select(
        "id, status, payment_method, payment_status, total_price, pickup_method, buyer:users(id), seller템:sellers(id), order_items(id, quantity, price_per_item, product_id, variant_id, discount_source)"
      )
      .eq("payment_status", "pending")
      .not("payment_expiry", "is", null)
      .lt("payment_expiry", now);

    canceledCount += await autoCancelOrders(
      expiredPayments,
      "❌ Batal otomatis karena pembayaran kadaluarsa."
    );

    console.log(`⚡ Auto-cancel total ${canceledCount} pesanan.`);
  } catch (err) {
    console.error("❌ Auto-cancel job error:", err.message);
  }
});
