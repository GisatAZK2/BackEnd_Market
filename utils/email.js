const nodemailer = require("nodemailer");
const QRCodeGen = require("qrcode-generator");

const FROM_EMAIL = "gisatazk2@gmail.com";
const EMAIL_PASSWORD = "kpld krrk ratp hbyl"; // App password Gmail

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: FROM_EMAIL,
    pass: EMAIL_PASSWORD,
  },
});

async function sendOrderNotification({
  order_id,
  products,
  buyer_email,
  seller_email,
  buyer_username,
}) {
  const generateQRCode = (text) => {
    try {
      const qr = QRCodeGen(0, "M"); // typeNumber 0 = auto, Error Correction M
      qr.addData(text);
      qr.make();
      return qr.createDataURL(6); // 6 = ukuran pixel per modul
    } catch (err) {
      console.error("Error generating QR code:", err);
      return null;
    }
  };

  const htmlEmailTemplate = (title, message, isBuyer, qrCodeUrl) => {
    const productListHTML = products
      .map(
        (p) => `
      <div class="product">
        <div><strong>${p.product_name}</strong> ${
          p.variant_name ? `- ${p.variant_name}` : ""
        }</div>
        <div>Jumlah: ${p.quantity}</div>
        <div>Total Harga: <span class="highlight">Rp${p.total_price.toLocaleString(
          "id-ID",
        )}</span></div>
        ${
          p.product_image_url
            ? `<img src="${p.product_image_url}" alt="${p.product_name}" style="max-width:120px;border-radius:6px;margin-top:5px;">`
            : ""
        }
      </div>
      <hr>
    `,
      )
      .join("");

    return `
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <title>${title}</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f5f7fa; }
          .container { background: white; border-radius: 8px; max-width: 600px; margin: auto; padding: 20px; }
          .header { background: ${isBuyer ? "#4CAF50" : "#2196F3"}; color: white; padding: 15px; border-radius: 8px 8px 0 0; }
          .highlight { color: ${isBuyer ? "#4CAF50" : "#2196F3"}; font-weight: bold; }
          img { display:block; margin-top:10px; }
          hr { border: none; border-top: 1px solid #ddd; margin: 10px 0; }
          .qr-code { margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header"><h2>${title}</h2></div>
          <p>${message}</p>
          ${productListHTML}
          ${
            !isBuyer
              ? `<p>Pembeli: <span class="highlight">${buyer_username}</span></p>`
              : ""
          }
          <p><strong>ID Pesanan:</strong> ${order_id}</p>
          ${
            qrCodeUrl
              ? `<img src="${qrCodeUrl}" alt="QR Code" class="qr-code" style="max-width:150px;">`
              : ""
          }
        </div>
      </body>
      </html>
    `;
  };

  const qrCodeUrl = generateQRCode(order_id);

  const tasks = [];

  if (buyer_email) {
    tasks.push(
      transporter.sendMail({
        from: `Produk Terdekat <${FROM_EMAIL}>`,
        to: buyer_email,
        subject: `🛒 Pesanan Anda Berhasil! - #${order_id}`,
        html: htmlEmailTemplate(
          "🎉 Terima kasih sudah memesan!",
          "Pesanan Anda sedang diproses dan siap diambil dalam 6 jam.",
          true,
          qrCodeUrl,
        ),
      }),
    );
  }

  if (seller_email) {
    tasks.push(
      transporter.sendMail({
        from: `Produk Terdekat <${FROM_EMAIL}>`,
        to: seller_email,
        subject: `📦 Pesanan Baru #${order_id} dari ${buyer_username}`,
        html: htmlEmailTemplate(
          "📢 Pesanan Baru Diterima!",
          "Segera proses pesanan ini agar pembeli puas.",
          false,
          qrCodeUrl,
        ),
      }),
    );
  }

  const results = await Promise.allSettled(tasks);

  results.forEach((res, i) => {
    if (res.status === "fulfilled") {
      console.log(`✅ Email ${i + 1} terkirim`);
    } else {
      console.error(`❌ Email ${i + 1} gagal:`, res.reason.message);
    }
  });
}

module.exports = sendOrderNotification;
