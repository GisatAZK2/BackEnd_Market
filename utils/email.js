const nodemailer = require("nodemailer");

const FROM_EMAIL = "gisatazk2@gmail.com";
const EMAIL_PASSWORD = "kpld krrk ratp hbyl"; // App password Gmail

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: FROM_EMAIL,
    pass: EMAIL_PASSWORD,
  },
});

/**
 * Kirim email notifikasi order ke buyer & seller
 * Mendukung pengiriman gabungan (grouped order)
 */
async function sendOrderNotification({
  isGrouped = false,
  buyer_email,
  seller_email,
  buyer_username,
  product_name,
  variant_name,
  quantity,
  total_price,
  product_image_url,
  productDetails = [],
}) {
  const htmlEmailTemplate = (title, message, isBuyer, isGrouped) => `
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600&display=swap');
        body {
          font-family: 'Poppins', Arial, sans-serif;
          margin: 0;
          padding: 0;
          background-color: #f5f7fa;
          color: #333;
          line-height: 1.6;
        }
        .container {
          max-width: 600px;
          margin: 20px auto;
          background: #ffffff;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }
        .header {
          background: ${isBuyer ? "#4CAF50" : "#2196F3"};
          color: white;
          padding: 25px 30px;
          text-align: center;
        }
        .header h1 {
          margin: 0;
          font-size: 24px;
          font-weight: 600;
        }
        .content {
          padding: 30px;
        }
        .order-details {
          background: #f9f9f9;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 25px;
        }
        .detail-row {
          display: flex;
          margin-bottom: 10px;
        }
        .detail-label {
          font-weight: 500;
          width: 120px;
          color: #666;
        }
        .detail-value {
          flex: 1;
          font-weight: 400;
        }
        .product-image {
          text-align: center;
          margin: 20px 0;
        }
        .product-image img {
          max-width: 200px;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          border: 1px solid #eee;
        }
        .message {
          background: #f0f8ff;
          padding: 15px;
          border-radius: 8px;
          border-left: 4px solid ${isBuyer ? "#4CAF50" : "#2196F3"};
          margin: 20px 0;
        }
        .footer {
          text-align: center;
          padding: 15px;
          color: #888;
          font-size: 12px;
          border-top: 1px solid #eee;
        }
        .highlight {
          color: ${isBuyer ? "#4CAF50" : "#2196F3"};
          font-weight: 500;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${title}</h1>
        </div>
        <div class="content">
          ${isGrouped ? htmlOrderList : htmlSingleItem}
          <div class="message">
            <p>${message}</p>
          </div>
          <p style="text-align: center; margin-top: 25px;">
            <a href="#" style="display: inline-block; padding: 12px 25px;
              background: ${isBuyer ? "#4CAF50" : "#2196F3"};
              color: white; text-decoration: none; border-radius: 6px;
              font-weight: 500;">
              ${isBuyer ? "Lihat Detail Pesanan" : "Kelola Pesanan"}
            </a>
          </p>
        </div>
        <div class="footer">
          <p>Email ini dikirim otomatis oleh sistem Produk Terdekat. Harap tidak membalas email ini.</p>
          <p>© ${new Date().getFullYear()} Produk Terdekat. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const htmlSingleItem = `
    <div class="order-details">
      <div class="detail-row">
        <div class="detail-label">Produk:</div>
        <div class="detail-value">${product_name}</div>
      </div>
      ${
        variant_name
          ? `
      <div class="detail-row">
        <div class="detail-label">Varian:</div>
        <div class="detail-value">${variant_name}</div>
      </div>`
          : ""
      }
      <div class="detail-row">
        <div class="detail-label">Jumlah:</div>
        <div class="detail-value">${quantity}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Total Harga:</div>
        <div class="detail-value highlight">Rp${Number(total_price).toLocaleString("id-ID")}</div>
      </div>
      ${
        !isBuyer
          ? `
      <div class="detail-row">
        <div class="detail-label">Pembeli:</div>
        <div class="detail-value highlight">${buyer_username}</div>
      </div>`
          : ""
      }
      <div class="product-image">
        <img src="${product_image_url}" alt="${product_name}">
      </div>
    </div>
  `;

  const htmlOrderList = productDetails
    .map(
      (p) => `
    <div class="order-details">
      <div class="detail-row">
        <div class="detail-label">Produk:</div>
        <div class="detail-value">${p.product_name}</div>
      </div>
      ${
        p.variant_name
          ? `
      <div class="detail-row">
        <div class="detail-label">Varian:</div>
        <div class="detail-value">${p.variant_name}</div>
      </div>`
          : ""
      }
      <div class="detail-row">
        <div class="detail-label">Jumlah:</div>
        <div class="detail-value">${p.quantity}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Subtotal:</div>
        <div class="detail-value">Rp${Number(p.price).toLocaleString("id-ID")}</div>
      </div>
      <div class="product-image">
        <img src="${p.image_url}" alt="${p.product_name}">
      </div>
    </div>
  `,
    )
    .join("");

  const buyerMail = {
    from: `Produk Terdekat <${FROM_EMAIL}>`,
    to: buyer_email,
    subject: `🛒 Pesanan Anda Berhasil!`,
    html: htmlEmailTemplate(
      isGrouped
        ? "🎉 Checkout Gabungan Berhasil!"
        : "🎉 Terima kasih sudah memesan!",
      isGrouped
        ? "Pesanan Anda telah digabung dan sedang diproses oleh penjual. Kami akan kirim notifikasi saat status berubah."
        : "Pesanan Anda sedang diproses dan siap diambil dalam 6 jam.",
      true,
      isGrouped,
    ),
  };

  const sellerMail = {
    from: `Produk Terdekat <${FROM_EMAIL}>`,
    to: seller_email,
    subject: `📦 Pesanan Baru dari ${buyer_username}`,
    html: htmlEmailTemplate(
      isGrouped
        ? "📦 Checkout Gabungan Diterima!"
        : "📢 Pesanan Baru Diterima!",
      isGrouped
        ? "Ada pesanan gabungan dari pembeli. Segera proses pesanan dan pastikan stok tersedia."
        : "Segera proses pesanan ini untuk memastikan pengalaman terbaik bagi pembeli.",
      false,
      isGrouped,
    ),
  };

  try {
    await transporter.sendMail(buyerMail);
    await transporter.sendMail(sellerMail);
    console.log(`✅ Email order dikirim ke ${buyer_email} & ${seller_email}`);
  } catch (err) {
    console.error("❌ Gagal kirim email order:", err.message);
  }
}

module.exports = sendOrderNotification;
