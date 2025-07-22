const express = require('express');
const supabase = require('../config/supabase');
const router = express.Router();

// 🛒 Buat pesanan baru
router.post('/order', async (req, res) => {
  const { user_id, product_id, quantity } = req.body;

  if (!user_id || !product_id || !quantity) {
    return res.status(400).json({ message: '❌ Semua field wajib diisi' });
  }

  try {
    const { data: product, error: productErr } = await supabase
      .from('products')
      .select('*')
      .eq('id', product_id)
      .single();

    if (productErr || !product) {
      return res.status(404).json({ message: '❌ Produk tidak ditemukan' });
    }

    const total_price = product.product_price * quantity;
    const pickupDeadline = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6 jam dari sekarang

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

    return res.status(201).json({ message: '✅ Order berhasil dibuat', order });
  } catch (err) {
    return res.status(500).json({ message: '❌ Server error', error: err.message });
  }
});

module.exports = router;
