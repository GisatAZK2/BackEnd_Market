const nodemailer = require("nodemailer");
const QRCode = require("qrcode");

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
  // Generate QR code sebagai buffer (bukan base64)
  const qrCodeBuffer = await QRCode.toBuffer(order_id);

  const htmlEmailTemplate = (title, message, isBuyer) => {
    const productListHTML = products
      .map(
        (p) => `
      <div style="margin-bottom: 20px; padding: 15px; background: #f9f9f9; border-radius: 8px;">
        <div style="font-size: 16px; font-weight: 600; margin-bottom: 5px;">
          ${p.product_name} ${p.variant_name ? `<span style="color: #666;">- ${p.variant_name}</span>` : ""}
        </div>
        <div style="margin-bottom: 5px;">Jumlah: ${p.quantity}</div>
        <div style="font-weight: 600; color: ${isBuyer ? "#4CAF50" : "#2196F3"};">Rp${p.total_price.toLocaleString("id-ID")}</div>
        ${
          p.product_image_url
            ? `
        <div style="margin-top: 10px;">
          <img src="${p.product_image_url}" alt="${p.product_name}" style="max-width: 150px; border-radius: 6px; border: 1px solid #eee;">
        </div>`
            : ""
        }
      </div>`,
      )
      .join("");

    return `
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${title}</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap');
          body { font-family: 'Poppins', Arial, sans-serif; background: #f7fafc; margin: 0; padding: 0; }
          .container { background: white; border-radius: 12px; max-width: 600px; margin: 20px auto; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
          .header { background: ${isBuyer ? "#4CAF50" : "#2196F3"}; color: white; padding: 25px; text-align: center; }
          .content { padding: 25px; }
          .highlight { color: ${isBuyer ? "#4CAF50" : "#2196F3"}; font-weight: 600; }
          .divider { height: 1px; background: #e2e8f0; margin: 20px 0; }
          .order-id { background: #f8fafc; padding: 12px; border-radius: 6px; text-align: center; font-weight: 500; margin: 20px 0; }
          .qr-container { text-align: center; margin: 30px 0 10px; }
          .qr-code { width: 150px; height: 150px; margin: 0 auto; }
          .footer { text-align: center; padding: 15px; font-size: 12px; color: #718096; background: #f7fafc; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0; font-size: 24px;">${title}</h1>
          </div>

          <div class="content">
            <p style="font-size: 15px; line-height: 1.6; color: #4a5568;">${message}</p>

            <h3 style="color: #2d3748; margin-top: 25px; margin-bottom: 15px;">Detail Produk</h3>
            ${productListHTML}

            ${!isBuyer ? `<p style="font-size: 15px;">Pembeli: <span class="highlight">${buyer_username}</span></p>` : ""}

            <div class="order-id">
              ID Pesanan: <span style="font-weight: 600;">${order_id}</span>
            </div>

            <div class="qr-container">
              <p style="margin-bottom: 15px; color: #4a5568;">Scan QR Code untuk detail pesanan</p>
              <img src="cid:qrcode@produk-terdekat" alt="QR Code Order ID" class="qr-code" />
            </div>
          </div>

          <div class="footer">
            <p style="margin: 0;">© ${new Date().getFullYear()} Produk Terdekat. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  };

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
        ),
        attachments: [
          {
            filename: "qrcode.png",
            content: qrCodeBuffer,
            cid: "qrcode@produk-terdekat",
          },
        ],
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
        ),
        attachments: [
          {
            filename: "qrcode.png",
            content: qrCodeBuffer,
            cid: "qrcode@produk-terdekat",
          },
        ],
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
