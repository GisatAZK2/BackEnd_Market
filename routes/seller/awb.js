// awb.js
const express = require("express");
const supabase = require("../../config/supabase");
const router = express.Router();
const { DateTime } = require("luxon");
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const sendOrderNotification = require("../../utils/email");

router.post("/seller/generate-awb", async (req, res) => {
  try {
    const sellerInfo = req.cookies?.seller_info ? JSON.parse(req.cookies.seller_info) : null;
    if (!sellerInfo?.id) {
      return res.status(401).json({ message: "❌ Harus login sebagai seller." });
    }

    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ message: "⚠️ Harap berikan array orderIds yang valid." });
    }

    // Fetch all orders for the seller
    const { data: ordersData, error: orderError } = await supabase
      .from("orders")
      .select(`
        id, created_at, total_price, status, pickup_method, buyer_address, seller_address,
        buyer:users(nama_penerima, no_telepon, email, username)
      `)
      .in("id", orderIds)
      .eq("seller_id", sellerInfo.id);

    if (orderError || !ordersData || ordersData.length === 0) {
      return res.status(404).json({ message: "❌ Order tidak ditemukan atau tidak milik seller ini." });
    }

    // Update order status to "sedang di kemas"
    const { error: updateError } = await supabase
      .from("orders")
      .update({ status: "sedang di kemas" })
      .in("id", orderIds)
      .eq("seller_id", sellerInfo.id);

    if (updateError) {
      return res.status(500).json({ message: "❌ Gagal memperbarui status order.", error: updateError.message });
    }

    // Fetch items for all orders
    const [orderItemsRes, detailItemsRes] = await Promise.all([
      supabase.from("order_items").select("*").in("order_id", orderIds),
      supabase.from("order_details_items").select("*").in("order_id", orderIds),
    ]);

    const orderItems = orderItemsRes.data || [];
    const detailItems = detailItemsRes.data || [];

    // Map items per order
    const itemsByOrder = {};
    detailItems.forEach(item => {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      const oi = orderItems.find(oi => oi.order_id === item.order_id && oi.product_id === item.product_id && oi.variant_id === item.variant_id);
      itemsByOrder[item.order_id].push({
        product_name: item.product_name,
        quantity: oi?.quantity || 0,
        variant_name: item.variant_name || null,
      });
    });
        // QR Codes
    const qrCodes = {};
    for (const order of ordersData) {
      try {
        const qrData = JSON.stringify({
          orderId: order.id,
          sellerId: sellerInfo.id,
          date: order.created_at,
        });
        qrCodes[order.id] = await QRCode.toDataURL(qrData, { width: 100 });
      } catch {
        qrCodes[order.id] = null;
      }
    }

    // Logo
    let logoBuffer;
    try {
      const logoUrl =
        "https://hihfiptclwrwuklojdec.supabase.co/storage/v1/object/public/store-photos/BG-Logo-Aplikasi.png";
      const response = await axios.get(logoUrl, {
        responseType: "arraybuffer",
      });
      logoBuffer = Buffer.from(response.data);
    } catch {
      logoBuffer = null;
    }

    // Page generator
    const generatePDFPage = (doc, order, logoBuffer) => {
      const buyerAddress =
        typeof order.buyer_address === "string"
          ? JSON.parse(order.buyer_address)
          : order.buyer_address;
      const sellerAddress =
        typeof order.seller_address === "string"
          ? JSON.parse(order.seller_address)
          : order.seller_address;

      const buyerFullAddress = [
        buyerAddress?.alamat_lengkap,
        buyerAddress?.kelurahan,
        buyerAddress?.kecamatan,
        buyerAddress?.kota_kabupaten,
        buyerAddress?.provinsi,
        buyerAddress?.kode_pos,
      ]
        .filter(Boolean)
        .join(", ");

      const sellerFullAddress = [
        sellerAddress?.store_address,
        sellerAddress?.kelurahan,
        sellerAddress?.kecamatan,
        sellerAddress?.kota_kabupaten,
        sellerAddress?.provinsi,
        sellerAddress?.kode_pos,
      ]
        .filter(Boolean)
        .join(", ");

      const itemsList = (itemsByOrder[order.id] || []).map((item) => ({
        product_name: item.product_name,
        variant_name: item.variant_name,
        quantity: item.quantity,
      }));

      // Calculate hAddr for product section border
      const hAddr = order.pickup_method.toLowerCase() === "diantar"
        ? doc.heightOfString(buyerFullAddress, { width: 105 })
        : doc.heightOfString(sellerFullAddress, { width: 105 });

      // Background pattern
      doc.save();
      doc.opacity(0.03);
      for (let i = 0; i < 10; i++) {
        doc.rect(18 + i * 25, 18, 20, 360).fillColor('#1e40af').fill();
      }
      doc.restore();

      // Border
      doc.lineWidth(1).rect(18, 18, 216, 360).strokeColor("#d1d5db").stroke();

      // Header with improved design
      doc.rect(18, 18, 216, 32).fillColor('#fbbf24').fill();
      
      if (logoBuffer) {
        doc.image(logoBuffer, 20, 20, { width: 25, height: 25 });
      }
      
      doc
        .fontSize(14)
        .font("Helvetica-Bold")
        .fillColor("#1e40af")
        .text("SHIPPING LABEL", 55, 22);
      
      doc
        .fontSize(8)
        .font("Helvetica")
        .fillColor("#1e40af")
        .text(`ID: ${order.id}`, 55, 38);
      
      doc.roundedRect(180, 22, 40, 15, 4).fillColor("#1e40af").fill();
      doc
        .fontSize(8)
        .font("Helvetica-Bold")
        .fillColor("#ffffff")
        .text(order.pickup_method.toUpperCase(), 180, 27, {
          align: "center",
          width: 40,
        });
      
      doc
        .moveTo(20, 50)
        .lineTo(232, 50)
        .lineWidth(1)
        .strokeColor("#d1d5db")
        .stroke();

      // Receiver or Pickup Instruction
      if (order.pickup_method.toLowerCase() === "diantar") {
        doc
          .fontSize(8)
          .font("Helvetica-Bold")
          .fillColor("#1d4ed8")
          .text("Penerima", 20, 60);

        let yAddr = 75;
        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .fillColor("#000")
          .text(order.buyer?.nama_penerima || order.buyer?.username, 25, yAddr, {
            width: 95,
          });
        yAddr += 10;

        doc
          .fontSize(7)
          .font("Helvetica")
          .text(buyerFullAddress, 25, yAddr, { width: 105 });
        yAddr += hAddr;
        doc
          .fontSize(7)
          .text(`Telp: ${order.buyer?.no_telepon || "-"}`, 25, yAddr, {
            width: 105,
          });

        var receiverBottom = yAddr + 5;
      } else {
        // For "diambil", show pickup instruction with full seller address
        doc
          .fontSize(8)
          .font("Helvetica-Bold")
          .fillColor("#1d4ed8")
          .text("Instruksi Pengambilan", 20, 60);
        
        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .fillColor("#000")
          .text("Ambil di Toko", 25, 75, { width: 95 });
        
        doc
          .fontSize(7)
          .font("Helvetica")
          .text(sellerFullAddress, 25, 90, { width: 105 });
        
        var receiverBottom = 90 + hAddr + 5;
      }

      // Sender information
      if (order.pickup_method.toLowerCase() === "diantar") {
        // Regular sender info for delivery
        doc
          .fontSize(8)
          .font("Helvetica-Bold")
          .fillColor("#1d4ed8")
          .text("Pengirim", 140, 60);

        let ySend = 75;
        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .fillColor("#000")
          .text(sellerInfo.store_name || "Toko Anda", 145, ySend, { width: 85 });
        ySend += 12;

        const hSend = doc.heightOfString(sellerFullAddress, { width: 85 });
        doc
          .fontSize(7)
          .font("Helvetica")
          .text(sellerFullAddress, 145, ySend, { width: 85 });

        var senderBottom = ySend + hSend + 5;
      } else {
        // For "diambil", show buyer info instead of sender
        doc
          .fontSize(8)
          .font("Helvetica-Bold")
          .fillColor("#1d4ed8")
          .text("Penerima", 140, 60);

        let ySend = 75;
        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .fillColor("#000")
          .text(order.buyer?.nama_penerima || order.buyer?.username, 145, ySend, { width: 85 });
        ySend += 12;

        doc
          .fontSize(7)
          .font("Helvetica")
          .text(`Telp: ${order.buyer?.no_telepon || "-"}`, 145, ySend, { width: 85 });
        ySend += 10;
        
        doc
          .fontSize(7)
          .font("Helvetica")
          .text(`Kota: ${order.buyer?.kota_kabupaten || "-"}`, 145, ySend, { width: 85 });

        var senderBottom = ySend + 10;
      }

      // Dynamic Y start for product
      let yStart = Math.max(receiverBottom, senderBottom) + 5;

      // Product section with improved design
      doc.roundedRect(18, yStart - 5, 216, 20, 4).fillColor("#fbbf24").fill();
      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .fillColor("#1e40af")
        .text("DETAIL PRODUK", 25, yStart);
      
      yStart += 15;
      
      // Product items with alternating background
      let y = yStart;
      itemsList.forEach((item, index) => {
        // Alternate background color for items
        if (index % 2 === 0) {
          doc.rect(20, y, 205, 20).fillColor("#f3f4f6").fill();
        }
        
        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .fillColor("#000")
          .text(item.product_name, 25, y + 5, { width: 150 });
        
        if (item.variant_name) {
          doc
            .fontSize(7)
            .font("Helvetica")
            .fillColor("#6b7280")
            .text(item.variant_name, 25, y + 15, { width: 150 });
        }
        
        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .fillColor("#000")
          .text(`x ${item.quantity}`, 175, y + 5, { align: "right", width: 45 });
        
        y += item.variant_name ? 25 : 20;
      });

      // Calculate product section height
      const productSectionHeight = y - yStart;
      
      // Prices section - only show for delivery
      if (order.pickup_method.toLowerCase() === "diantar") {
        doc.roundedRect(20, y + 10, 95, 30, 4).fillColor("#dbeafe").fill();
        doc.fontSize(8).fillColor("#1d4ed8").text("Total Harga", 25, y + 15);
        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .fillColor("#1e40af")
          .text(`Rp ${order.total_price.toLocaleString()}`, 25, y + 25);
        
        doc.roundedRect(130, y + 10, 95, 30, 4).fillColor("#dbeafe").fill();
        doc.fontSize(8).fillColor("#1d4ed8").text("Ongkir", 135, y + 15);
        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .fillColor("#1e40af")
          .text(
            `Rp ${order.shipping_cost?.toLocaleString() || "10,000"}`,
            135,
            y + 25
          );
      } else {
        // For pickup, add a note instead of prices
        doc.roundedRect(20, y + 10, 205, 20, 4).fillColor("#fef3c7").fill();
        doc.fontSize(8).fillColor("#92400e").text("Pembayaran dilakukan di toko", 25, y + 15);
      }

      // Footer with improved design
      doc
        .moveTo(20, 310)
        .lineTo(232, 310)
        .lineWidth(1)
        .strokeColor("#93c5fd")
        .stroke();
      
      doc.rect(18, 310, 216, 68).fillColor("#f1f5f9").fill();
      
      doc
        .fontSize(8)
        .fillColor("#6b7280")
        .text(`Dicetak: ${new Date().toLocaleDateString("id-ID")} ${new Date().toLocaleTimeString("id-ID")}`, 20, 320);
      
      doc
        .fontSize(8)
        .fillColor("#6b7280")
        .text(`ID Order: ${order.id}`, 20, 330);
      
      if (qrCodes[order.id]) {
        doc.image(qrCodes[order.id], 178, 315, { width: 40, height: 40 });
        doc
          .fontSize(7)
          .fillColor("#6b7280")
          .text("Scan QR untuk verifikasi", 178, 360, { align: "center", width: 50 });
      }
      
      // Add decorative elements
      doc.circle(40, 340, 3).fillColor("#3b82f6").fill();
      doc.circle(50, 340, 3).fillColor("#10b981").fill();
      doc.circle(60, 340, 3).fillColor("#f59e0b").fill();
    };

    const generatePDF = (orders, logoBuffer) => {
      return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [252, 400], margin: 10 });
        const buffers = [];
        doc.on("data", buffers.push.bind(buffers));
        doc.on("end", () => {
          resolve(Buffer.concat(buffers));
        });

        orders.forEach((order, index) => {
          if (index > 0) doc.addPage();
          generatePDFPage(doc, order, logoBuffer);
        });

        doc.end();
      });
    };

    if (ordersData.length === 1) {
      const pdfBuffer = await generatePDF(ordersData, logoBuffer);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="shipping-label-${ordersData[0].id}.pdf"`
      );
      return res.send(pdfBuffer);
    }

    const pdfBuffer = await generatePDF(ordersData, logoBuffer);
    const pdfBase64 = pdfBuffer.toString("base64");

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Preview Shipping Labels</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
.pdf-preview { max-height: 500px; width: 100%; }
.download-btn:hover, .print-btn:hover { transform: scale(1.05); }
</style>
</head>
<body class="bg-gray-100 font-sans">
<header class="bg-orange-500 text-white p-4 flex items-center justify-center">
  <img src="https://hihfiptclwrwuklojdec.supabase.co/storage/v1/object/public/store-photos/BG-Logo-Aplikasi.png" class="h-10 mr-4">
  <h1 class="text-2xl font-bold">Preview Shipping Labels</h1>
</header>
<div class="container mx-auto p-4">
  <div class="bg-white p-4 rounded-lg shadow-md">
    <h2 class="text-lg font-semibold mb-2 text-blue-600">Order IDs: ${ordersData
      .map((o) => o.id)
      .join(", ")}</h2>
    <iframe class="pdf-preview" src="data:application/pdf;base64,${pdfBase64}" frameborder="0"></iframe>
    <div class="mt-4 flex justify-between">
      <button class="download-btn bg-blue-500 text-white px-4 py-2 rounded" onclick="downloadPDF('${pdfBase64}')">Download</button>
      <button class="print-btn bg-green-500 text-white px-4 py-2 rounded" onclick="printPDF('${pdfBase64}')">Print</button>
    </div>
  </div>
</div>
<script>
function downloadPDF(base64Data) {
  const link = document.createElement('a');
  link.href = 'data:application/pdf;base64,' + base64Data;
  link.download = 'shipping-labels.pdf';
  link.click();
}
function printPDF(base64Data) {
  const win = window.open('about:blank');
  win.document.write('<iframe src="data:application/pdf;base64,' + base64Data + '" style="width:100%;height:100%;" frameborder="0"></iframe>');
  win.document.close();
}
</script>
</body>
</html>
`;

    res.setHeader("Content-Type", "text/html");
    res.send(htmlContent);

  } catch (err) {
    console.error("❌ Server error (generate-awb):", err);
    return res.status(500).json({ message: "❌ Terjadi kesalahan server", error: err.message });
  }
});

module.exports = router;