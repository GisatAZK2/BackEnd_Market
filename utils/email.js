const { Resend } = require("resend");
const QRCode = require("qrcode");

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "Produk Terdekat <noreply@yourdomain.com>";

async function sendOrderNotification({
  order_id,
  products = [],
  buyer_email,
  seller_email,
  buyer_username,
  pickup_method,
  new_status,
  seller_address = {},
  cancel_reason = null,
  pdfBuffer = null,
}) {
  const isDiantar = pickup_method?.toLowerCase() === "diantar";
  const qrCodeDataURL = await QRCode.toDataURL(order_id); // ✅ inline base64

  // === Pesan berdasarkan status ===
  let buyerMessage = "";
  let sellerMessage = "";
  let titleBuyer = "";
  let titleSeller = "";

  switch (new_status) {
    case "pending":
      buyerMessage = isDiantar
        ? "Pesanan Anda menunggu konfirmasi seller."
        : "Pesanan Anda menunggu konfirmasi seller sebelum bisa diambil.";
      sellerMessage = "Ada pesanan baru! Segera konfirmasi.";
      titleBuyer = `🎉 Pesanan Baru (#${order_id})`;
      titleSeller = `📢 Pesanan Baru Masuk (#${order_id})`;
      break;
    case "sedang di kemas":
      buyerMessage = isDiantar
        ? "Pesanan Anda sedang dikemas dan akan segera dikirim."
        : "Pesanan Anda sedang dikemas dan akan siap diambil. Lampiran label pengiriman tersedia.";
      sellerMessage = "Segera kemas pesanan pembeli.";
      titleBuyer = `📦 Pesanan Sedang Dikemas (#${order_id})`;
      titleSeller = `📦 Segera Kemas Pesanan (#${order_id})`;
      break;
    case "siap di ambil":
      buyerMessage = "Pesanan siap diambil di toko seller dalam 12 jam.";
      sellerMessage = "Pesanan sudah ditandai siap diambil.";
      titleBuyer = `✅ Pesanan Siap Diambil - #${order_id}`;
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
      buyerMessage = `Pesanan Anda dibatalkan.${cancel_reason ? " Alasan: " + cancel_reason : ""}`;
      sellerMessage = `Pesanan dibatalkan.${cancel_reason ? " Alasan: " + cancel_reason : ""}`;
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
          ${p.product_name} ${p.variant_name ? `<span style="color: #666;">- ${p.variant_name}</span>` : ""}
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

    const addressSection =
      !isDiantar && seller_address
        ? `
        <h3>📍 Alamat Toko</h3>
        <p><b>Versi Terpisah:</b><br/>
           ${seller_address.store_address || "-"}, 
           Kel. ${seller_address.kelurahan || "-"}, 
           Kec. ${seller_address.kecamatan || "-"}, 
           ${seller_address.kabupaten || "-"}, 
           Prov. ${seller_address.provinsi || "-"}
           ${seller_address.kode_pos ? `, ${seller_address.kode_pos}` : ""}
        </p>
        <p><b>Versi Lengkap + Koordinat:</b><br/>
           ${seller_address.store_address || "-"}<br/>
           (Lat: ${seller_address.latitude || "-"}, Lng: ${seller_address.longitude || "-"})
        </p>
      `
        : "";

    return `
      <!DOCTYPE html>
      <html lang="id">
      <head><meta charset="UTF-8" /></head>
      <body>
        <div style="background: white; border-radius: 12px; max-width: 600px; margin: 20px auto; padding: 20px; font-family: Arial, sans-serif;">
          <h2 style="color: ${isBuyer ? "#4CAF50" : "#2196F3"};">${title}</h2>
          <p>${message}</p>
          <h3>Detail Produk</h3>
          ${productListHTML}
          ${!isBuyer ? `<p>Pembeli: <b>${buyer_username}</b></p>` : ""}
          <p>ID Pesanan: <b>${order_id}</b></p>
          <p>Metode Pengambilan: <b>${isDiantar ? "Diantar" : "Diambil di Toko"}</b></p>
          ${
            new_status === "dibatalkan" && cancel_reason
              ? `
            <h3>❌ Alasan Pembatalan</h3>
            <p>${cancel_reason}</p>
            `
              : ""
          }
          ${addressSection}
          ${
            (new_status === "sedang di kemas" || new_status === "diterima") && !isDiantar
              ? `<p>Lampiran: Label pengiriman telah dilampirkan dalam email ini.</p>`
              : ""
          }
          <div style="text-align:center; margin-top:20px;">
            <p>Scan QR Code untuk detail pesanan</p>
            <img src="${qrCodeDataURL}" alt="QR Code" width="150" height="150" />
          </div>
        </div>
      </body>
      </html>
    `;
  };

  // === Kirim email pembeli & seller ===
  const tasks = [];

  if (buyer_email) {
    tasks.push(
      resend.emails.send({
        from: FROM_EMAIL,
        to: buyer_email,
        subject: `[Produk Terdekat] ${titleBuyer}`,
        html: htmlEmailTemplate(titleBuyer, buyerMessage, true),
        attachments:
          pdfBuffer && (new_status === "sedang di kemas" || new_status === "diterima") && !isDiantar
            ? [
                {
                  filename: `shipping-label-${order_id}.pdf`,
                  content: pdfBuffer.toString("base64"),
                  encoding: "base64",
                },
              ]
            : [],
      })
    );
  }

  if (seller_email) {
    tasks.push(
      resend.emails.send({
        from: FROM_EMAIL,
        to: seller_email,
        subject: `[Produk Terdekat] ${titleSeller} - dari ${buyer_username}`,
        html: htmlEmailTemplate(titleSeller, sellerMessage, false),
      })
    );
  }

  await Promise.allSettled(tasks);
}

module.exports = sendOrderNotification;
