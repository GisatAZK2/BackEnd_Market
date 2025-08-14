const nodemailer = require("nodemailer");
const QRCode = require("qrcode");

const FROM_EMAIL = "gisatazk2@gmail.com";
const EMAIL_PASSWORD = "kpld krrk ratp hbyl";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: FROM_EMAIL, pass: EMAIL_PASSWORD },
});

async function sendOrderNotification({
  order_id,
  products,
  buyer_email,
  seller_email,
  buyer_username,
  pickup_method,
  paid,
}) {
  const isDiambil = pickup_method?.toLowerCase() === "diambil";
  const buyerMessage = isDiambil
    ? `Pesanan Anda siap diambil. ${
        paid ? "Pembayaran sudah diterima." : "Silakan bayar saat pengambilan."
      }`
    : "Pesanan Anda sedang diproses dan akan dikirim ke alamat Anda.";

  const sellerMessage = isDiambil
    ? "Segera persiapkan pesanan agar pembeli bisa mengambil tepat waktu."
    : "Segera proses pesanan untuk pengiriman.";

  // Generate QR code untuk barcode
  const qrCodeBuffer = await QRCode.toBuffer(order_id);

  const productListHTML = products
    .map(
      (p) => `
      <div style="margin-bottom: 20px; padding: 15px; background: #f9f9f9; border-radius: 8px;">
        <div style="font-size: 16px; font-weight: 600; margin-bottom: 5px;">
          ${p.product_name} ${p.variant_name ? `<span style="color:#666;">- ${p.variant_name}</span>` : ""}
        </div>
        <div>Jumlah: ${p.quantity}</div>
        <div style="font-weight:600;color:#4CAF50;">Rp${p.total_price.toLocaleString("id-ID")}</div>
        ${p.product_image_url ? `<img src="${p.product_image_url}" style="max-width:150px;border-radius:6px;margin-top:10px;border:1px solid #eee;" />` : ""}
      </div>`
    )
    .join("");

  const htmlEmailTemplate = (title, message, isBuyer) => `
  <html>
    <body>
      <div style="background:white;border-radius:12px;max-width:600px;margin:20px auto;padding:20px;font-family:Arial,sans-serif;">
        <h2 style="color:${isBuyer ? "#4CAF50" : "#2196F3"}">${title}</h2>
        <p>${message}</p>
        <h3>Detail Produk</h3>
        ${productListHTML}
        <p>ID Pesanan: <b>${order_id}</b></p>
        ${isDiambil && isBuyer ? `
        <div style="text-align:center;margin-top:15px;">
          <p>Scan QR Code untuk ambil pesanan:</p>
          <img src="cid:qrcode@produk-terdekat" width="150" height="150" />
        </div>` : ""}
        ${!isBuyer ? `<p>Pembeli: <b>${buyer_username}</b></p>` : ""}
      </div>
    </body>
  </html>`;

  const tasks = [];

  if (buyer_email) {
    tasks.push(
      transporter.sendMail({
        from: `Produk Terdekat <${FROM_EMAIL}>`,
        to: buyer_email,
        subject: `🛒 Pesanan Anda #${order_id}`,
        html: htmlEmailTemplate("🎉 Pesanan Anda!", buyerMessage, true),
        attachments: isDiambil
          ? [{ filename: "qrcode.png", content: qrCodeBuffer, cid: "qrcode@produk-terdekat" }]
          : [],
      })
    );
  }

  if (seller_email) {
    tasks.push(
      transporter.sendMail({
        from: `Produk Terdekat <${FROM_EMAIL}>`,
        to: seller_email,
        subject: `📦 Pesanan Baru #${order_id} dari ${buyer_username}`,
        html: htmlEmailTemplate("📢 Pesanan Baru!", sellerMessage, false),
        attachments: isDiambil
          ? [{ filename: "qrcode.png", content: qrCodeBuffer, cid: "qrcode@produk-terdekat" }]
          : [],
      })
    );
  }

  await Promise.allSettled(tasks);
}

module.exports = sendOrderNotification;
