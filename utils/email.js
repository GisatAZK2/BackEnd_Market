const nodemailer = require('nodemailer');

const FROM_EMAIL = 'gisatazk2@gmail.com';
const EMAIL_PASSWORD = 'kpld krrk ratp hbyl'; // App password Gmail

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: FROM_EMAIL,
    pass: EMAIL_PASSWORD,
  },
});

/**
 * Kirim email notifikasi order ke buyer & seller (gambar pakai URL langsung)
 */
async function sendOrderNotification({ product_name, quantity, total_price, product_image_url, buyer_email, seller_email }) {
  const htmlEmailTemplate = (title, message) => `
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <title>${title}</title>
    </head>
    <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f9f9f9;">
      <div style="max-width: 500px; margin: auto; background: #fff; padding: 20px; border-radius: 10px; box-shadow: 0 2px 6px rgba(0,0,0,0.1);">
        <h2>${title}</h2>
        <p><strong>Produk:</strong> ${product_name}</p>
        <p><strong>Quantity:</strong> ${quantity}</p>
        <p><strong>Total Harga:</strong> Rp${total_price.toLocaleString('id-ID')}</p>
        <div style="margin-top: 15px;">
          <img src="${product_image_url}" alt="Produk" style="width: 100%; max-width: 200px; border-radius: 8px;" />
        </div>
        <p style="margin-top: 20px;">${message}</p>
        <hr style="margin-top: 30px;">
        <small style="color: #666;">Email ini dikirim otomatis oleh sistem Produk Terdekat.</small>
      </div>
    </body>
    </html>
  `;

  const mailOptionsBuyer = {
    from: FROM_EMAIL,
    to: buyer_email,
    subject: `🛒 Pesanan Anda Berhasil!`,
    html: htmlEmailTemplate(
      '🎉 Terima kasih sudah memesan!',
      'Pesanan Anda sedang diproses dan siap diambil dalam 6 jam.'
    )
  };

  const mailOptionsSeller = {
    from: FROM_EMAIL,
    to: seller_email,
    subject: `📦 Ada Pesanan Baru!`,
    html: htmlEmailTemplate(
      '📢 Anda menerima pesanan baru!',
      'Segera proses pesanan ini untuk memastikan pengalaman terbaik bagi pembeli.'
    )
  };

  try {
    await transporter.sendMail(mailOptionsBuyer);
    await transporter.sendMail(mailOptionsSeller);
    console.log(`✅ Email order dikirim ke ${buyer_email} & ${seller_email}`);
  } catch (err) {
    console.error('❌ Gagal kirim email order:', err.message);
  }
}

module.exports = sendOrderNotification;
