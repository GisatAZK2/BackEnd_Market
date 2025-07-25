const express = require('express');
const supabase = require('../config/supabase');
const sendOrderNotification = require('../utils/email');
const router = express.Router();

// 🛒 Buat pesanan baru
router.post('/order', async (req, res) => {
  const { user_id, product_id, variant_id = null, quantity } = req.body;

  if (!user_id || !product_id || !quantity) {
    return res.status(400).json({ message: '❌ Semua field wajib diisi' });
  }

  try {
    // 🔍 Ambil data user
    const { data: userData } = await supabase
      .from('users')
      .select('email, username')
      .eq('id', user_id)
      .single();

    if (!userData) return res.status(404).json({ message: '❌ User tidak ditemukan' });

    // 🔍 Ambil data produk
    const { data: product } = await supabase
      .from('products')
      .select('*')
      .eq('id', product_id)
      .single();

    if (!product) return res.status(404).json({ message: '❌ Produk tidak ditemukan' });

    // 🔍 Ambil varian jika ada
    let variant = null;
    if (variant_id) {
      const { data: v } = await supabase
        .from('product_variants')
        .select('*')
        .eq('id', variant_id)
        .single();
      variant = v;
      if (!variant) return res.status(404).json({ message: '❌ Varian tidak ditemukan' });
    }

    // 💵 Hitung total harga
    const total_price = (variant ? variant.variant_price : product.product_price) * quantity;
    const pickupDeadline = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6 jam

    // 💾 Simpan order
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert([{
        user_id,
        product_id,
        seller_id: product.seller_id,
        variant_id,
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

    // 🔍 Ambil email penjual
    const { data: sellerData } = await supabase
      .from('sellers')
      .select('email')
      .eq('id', product.seller_id)
      .single();

    // 🖼️ Tentukan image URL dengan aman
    let imageUrl;
    if (variant?.variant_image_url) {
      imageUrl = variant.variant_image_url;
    } else if (Array.isArray(product.product_image_url)) {
      imageUrl = product.product_image_url[0];
    } else {
      imageUrl = product.product_image_url;
    }

    // Opsional: fallback jika image kosong
    if (!imageUrl || imageUrl.length < 5) {
      imageUrl = 'https://yourdomain.com/default-image.jpg'; // Ganti dengan gambar default-mu
    }

    // 📧 Kirim email
    const emailInfo = {
      product_name: product.product_name,
      variant_name: variant?.variant_name || null,
      quantity,
      total_price,
      product_image_url: imageUrl,
      buyer_email: userData.email,
      seller_email: sellerData?.email,
      buyer_username: userData.username
    };

    sendOrderNotification(emailInfo).catch(console.error);

    // ✅ Kirim response ke frontend
    return res.status(201).json({
      message: '✅ Order berhasil dibuat',
      order,
      product_name: product.product_name,
      variant_name: variant?.variant_name || null,
      product_image_url: imageUrl
    });

  } catch (err) {
    return res.status(500).json({ message: '❌ Server error', error: err.message });
  }
});

module.exports = router;
