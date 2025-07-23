const express = require('express');
const supabase = require('../config/supabase');
const sendOrderNotification = require('../utils/email');
const router = express.Router();

// 🛒 Buat pesanan baru
router.post('/order', async (req, res) => {
  const { user_id, product_id, quantity } = req.body;

  if (!user_id || !product_id || !quantity) {
    return res.status(400).json({ message: '❌ Semua field wajib diisi' });
  }

  try {
    // 🔍 Ambil data produk
    const { data: product, error: productErr } = await supabase
      .from('products')
      .select('*')
      .eq('id', product_id)
      .single();

    if (productErr || !product) {
      return res.status(404).json({ message: '❌ Produk tidak ditemukan' });
    }

    // 🔍 Ambil email user & seller
    const { data: userData } = await supabase
      .from('users')
      .select('email')
      .eq('id', user_id)
      .single();

    const { data: sellerData } = await supabase
      .from('sellers')
      .select('email')
      .eq('id', product.seller_id)
      .single();

    const total_price = product.product_price * quantity;
    const pickupDeadline = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6 jam dari sekarang

    // 💾 Simpan order
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert([{
        user_id,
        product_id,
        seller_id: product.seller_id,
        quantity,
        total_price,
        status: 'pending',
        pickup_deadline: pickupDeadline.toISOString()
      }])
      .select()
      .single();

    if (orderErr) {
      return res.status(500).json({ message: '❌ Gagal buat order', error: orderErr.message });
    }

    // 🚀 Kirim email di background tanpa blocking
    const emailInfo = {
      product_name: product.product_name,
      quantity,
      total_price,
      product_image_url: product.product_image_url,
      buyer_email: userData?.email,
      seller_email: sellerData?.email
    };

    sendOrderNotification(emailInfo).catch(console.error); // non-blocking, tetap log error

    return res.status(201).json({
      message: '✅ Order berhasil dibuat. Email dikirim di latar belakang.',
      order
    });
  } catch (err) {
    return res.status(500).json({ message: '❌ Server error', error: err.message });
  }
});

module.exports = router;
