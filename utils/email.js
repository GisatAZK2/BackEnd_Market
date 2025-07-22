const nodemailer = require('nodemailer');

const FROM_EMAIL = 'gisatazk2@gmail.com';
const EMAIL_PASSWORD = 'kpld krrk ratp hbyl'; // app password Gmail

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: FROM_EMAIL,
    pass: EMAIL_PASSWORD,
  },
});

// 📨 Kirim notifikasi order ke buyer & seller
async function sendOrderNotification({ product_name, quantity, total_price, product_image_url, buyer_email, seller_email }) {
  const mailOptionsBuyer = {
    from: FROM_EMAIL,
    to: buyer_email,
    subject: `🛒 Pesanan Anda Berhasil!`,
    html: `
      <div style="font-family: Arial; padding: 20px;">
        <h2>🎉 Terima kasih sudah memesan!</h2>
        <p><strong>Produk:</strong> ${product_name}</p>
        <p><strong>Quantity:</strong> ${quantity}</p>
        <p><strong>Total Harga:</strong> Rp${total_price.toLocaleString()}</p>
        <img src="${product_image_url}" alt="Produk" style="width: 150px; margin-top: 10px;" />
        <p style="margin-top: 20px;">Pesanan Anda sedang diproses dan siap diambil dalam 6 jam.</p>
      </div>
    `
  };

  const mailOptionsSeller = {
    from: FROM_EMAIL,
    to: seller_email,
    subject: `📦 Ada Pesanan Baru!`,
    html: `
      <div style="font-family: Arial; padding: 20px;">
        <h2>📢 Anda menerima pesanan baru!</h2>
        <p><strong>Produk:</strong> ${product_name}</p>
        <p><strong>Quantity:</strong> ${quantity}</p>
        <p><strong>Total Harga:</strong> Rp${total_price.toLocaleString()}</p>
        <img src="${product_image_url}" alt="Produk" style="width: 150px; margin-top: 10px;" />
        <p style="margin-top: 20px;">Segera proses pesanan ini untuk memastikan pengalaman terbaik bagi pembeli.</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptionsBuyer);
    await transporter.sendMail(mailOptionsSeller);
    console.log(`✅ Email order dikirim ke ${buyer_email} & ${seller_email}`);
  } catch (err) {
    console.error('❌ Gagal kirim email order:', err.message);
  }
}

module.exports = { sendOrderNotification };
