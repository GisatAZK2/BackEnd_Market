// file: utils/sendOrderNotification.js
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
  products = [],
  buyer_email,
  seller_email,
  buyer_username,
  pickup_method,
  new_status,
}) {
  const isDiantar = pickup_method?.toLowerCase() === "diantar";
  const qrCodeBuffer = await QRCode.toBuffer(order_id);

  // === Pesan berdasarkan status & pickup_method ===
  let buyerMessage = "";
  let sellerMessage = "";
  let titleBuyer = "";
  let titleSeller = "";

  switch (new_status) {
    case "pending":
      buyerMessage = isDiantar
        ? "Pesanan Anda menunggu konfirmasi seller dan akan segera diantar."
        : "Pesanan Anda menunggu konfirmasi seller sebelum bisa diambil.";
      sellerMessage = "Ada pesanan baru! Segera konfirmasi.";
      titleBuyer = `🎉 Pesanan Baru (#${order_id})`;
      titleSeller = `📢 Pesanan Baru Masuk (#${order_id})`;
      break;

    case "sedang di kemas":
      buyerMessage = isDiantar
        ? "Pesanan Anda sedang dikemas dan akan segera dikirim."
        : "Pesanan Anda sedang dikemas dan akan siap diambil.";
      sellerMessage = "Segera kemas pesanan pembeli.";
      titleBuyer = `📦 Pesanan Sedang Dikemas (#${order_id})`;
      titleSeller = `📦 Segera Kemas Pesanan (#${order_id})`;
      break;

    case "siap di ambil":
      buyerMessage = isDiantar
        ? "Pesanan siap dikirim oleh seller."
        : "Pesanan siap diambil di toko seller dalam 12 jam.";
      sellerMessage = isDiantar
        ? "Pesanan sudah siap, segera lakukan pengiriman."
        : "Pesanan sudah ditandai siap diambil.";
      titleBuyer = `✅ Pesanan Siap (${isDiantar ? "Diantar" : "Diambil"}) - #${order_id}`;
      titleSeller = `✅ Pesanan Siap Diproses (#${order_id})`;
      break;

    case "sedang di antar":
      buyerMessage = "Pesanan Anda sedang dalam perjalanan ke alamat Anda.";
      sellerMessage = "Pesanan sudah ditandai sedang dikirim.";
      titleBuyer = `🚚 Pesanan Sedang Dikirim (#${order_id})`;
      titleSeller = `🚚 Pesanan Dalam Pengiriman (#${order_id})`;
      break;

    case "diterima":
      buyerMessage = "Pesanan Anda sudah selesai. Terima kasih sudah berbelanja!";
      sellerMessage = "Pesanan selesai diterima pembeli.";
      titleBuyer = `🎉 Pesanan Selesai (#${order_id})`;
      titleSeller = `🎉 Pesanan Selesai (#${order_id})`;
      break;

    case "dibatalkan":
      buyerMessage = "Pesanan Anda dibatalkan.";
      sellerMessage = "Pesanan dibatalkan.";
      titleBuyer = `❌ Pesanan Dibatalkan (#${order_id})`;
      titleSeller = `❌ Pesanan Dibatalkan (#${order_id})`;
      break;
  }

  // === Template Email ===
  const htmlEmailTemplate = (title, message, isBuyer) => {
    const productListHTML = products
      .map(
        (p) => `
        <div style="margin-bottom: 20px; padding: 15px; background: #f9f9f9; border-radius: 8px;">
          <div style="font-size: 16px; font-weight: 600; margin-bottom: 5px;">
            ${p.product_name} ${
          p.variant_name ? `<span style="color: #666;">- ${p.variant_name}</span>` : ""
        }
          </div>
          <div style="margin-bottom: 5px;">Jumlah: ${p.quantity}</div>
          <div style="font-weight: 600; color: ${isBuyer ? "#4CAF50" : "#2196F3"};">
            Rp${p.total_price.toLocaleString("id-ID")}
          </div>
          ${
            p.product_image_url
              ? `<div style="margin-top: 10px;">
                  <img src="${p.product_image_url}" alt="${p.product_name}" style="max-width: 150px; border-radius: 6px; border: 1px solid #eee;">
                 </div>`
              : ""
          }
        </div>
      `
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
          <p>Metode Pengambilan: <b>${isDiantar ? "Diantar" : "Diambil di Toko"}</b></p>
          <div style="text-align:center; margin-top:20px;">
            <p>Scan QR Code untuk detail pesanan</p>
            <img src="cid:qrcode@produk-terdekat" alt="QR Code" width="150" height="150" />
          </div>
        </div>
      </body>
      </html>
    `;
  };

  // === Kirim email buyer & seller ===
  const tasks = [];

  if (buyer_email) {
    tasks.push(
      transporter.sendMail({
        from: `Produk Terdekat <${FROM_EMAIL}>`,
        to: buyer_email,
        subject: `[Produk Terdekat] ${titleBuyer}`, // ✅ subject buyer
        html: htmlEmailTemplate(titleBuyer, buyerMessage, true),
        attachments: [
          {
            filename: "qrcode.png",
            content: qrCodeBuffer,
            cid: "qrcode@produk-terdekat",
          },
        ],
      })
    );
  }

  if (seller_email) {
    tasks.push(
      transporter.sendMail({
        from: `Produk Terdekat <${FROM_EMAIL}>`,
        to: seller_email,
        subject: `[Produk Terdekat] ${titleSeller} - dari ${buyer_username}`, // ✅ subject seller tambah nama pembeli
        html: htmlEmailTemplate(titleSeller, sellerMessage, false),
        attachments: [
          {
            filename: "qrcode.png",
            content: qrCodeBuffer,
            cid: "qrcode@produk-terdekat",
          },
        ],
      })
    );
  }

  await Promise.allSettled(tasks);
}

module.exports = sendOrderNotification;
