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
}) {
  const isDiantar = pickup_method?.toLowerCase() === "diantar";

  const buyerMessage = isDiantar
    ? "Pesanan Anda sedang diproses dan akan dikirim ke alamat Anda."
    : "Pesanan Anda sedang diproses dan siap diambil dalam 6 jam.";

  const sellerMessage = isDiantar
    ? "Segera proses pesanan dan lakukan pengiriman."
    : "Segera proses pesanan agar pembeli bisa mengambil tepat waktu.";

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
          <div style="font-weight: 600; color: ${isBuyer ? "#4CAF50" : "#2196F3"};">
            Rp${p.total_price.toLocaleString("id-ID")}
          </div>
          ${
            p.product_image_url
              ? `
            <div style="margin-top: 10px;">
              <img src="${p.product_image_url}" alt="${p.product_name}" style="max-width: 150px; border-radius: 6px; border: 1px solid #eee;">
            </div>
          `
              : ""
          }
        </div>
      `,
      )
      .join("");

    return `
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${title}</title>
      </head>
      <body>
        <div style="background: white; border-radius: 12px; max-width: 600px; margin: 20px auto; padding: 20px; font-family: Arial, sans-serif;">
          <h2 style="color: ${isBuyer ? "#4CAF50" : "#2196F3"};">${title}</h2>
          <p>${message}</p>
          <h3>Detail Produk</h3>
          ${productListHTML}
          ${!isBuyer ? `<p>Pembeli: <b>${buyer_username}</b></p>` : ""}
          <p>ID Pesanan: <b>${order_id}</b></p>
          <div style="text-align:center;">
            <p>Scan QR Code untuk detail pesanan</p>
            <img src="cid:qrcode@produk-terdekat" alt="QR Code" width="150" height="150" />
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
          buyerMessage,
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
          sellerMessage,
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

  await Promise.allSettled(tasks);
}

module.exports = sendOrderNotification;
