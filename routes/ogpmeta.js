const express = require('express');
const supabase = require('../config/supabase');
const router = express.Router();

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !product) {
      return res.status(404).send('<h1>❌ Produk tidak ditemukan</h1>');
    }

    // Ambil gambar utama
    let ogImage = '';
    try {
      const parsed = JSON.parse(product.product_image_url);
      ogImage = Array.isArray(parsed) ? parsed[0] : product.product_image_url;
    } catch {
      ogImage = product.product_image_url;
    }

    // Link frontend (yang akan diakses user setelah klik)
    const frontendUrl = `https://cihuy.sytes.net/detail/produk/${encodeURIComponent(product.product_name)}/${id}`;

    // Schema.org JSON-LD
    const jsonLD = {
      "@context": "https://schema.org/",
      "@type": "Product",
      "name": product.product_name,
      "description": product.product_description || "",
      "image": ogImage,
      "sku": id,
      "brand": { "@type": "Brand", "name": "CIHUY STORE" },
      "offers": {
        "@type": "Offer",
        "url": frontendUrl,
        "availability": "https://schema.org/InStock"
      }
    };

    // HTML untuk WhatsApp preview
    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <title>${product.product_name}</title>
    <meta name="description" content="${product.product_description || ''}" />
    <meta property="og:title" content="${product.product_name}" />
    <meta property="og:description" content="${product.product_description || ''}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:image:width" content="600" />
    <meta property="og:image:height" content="600" />
    <meta property="og:url" content="${frontendUrl}" />
    <meta property="og:type" content="product" />
    <meta property="og:site_name" content="CIHUY STORE" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${product.product_name}" />
    <meta name="twitter:description" content="${product.product_description || ''}" />
    <meta name="twitter:image" content="${ogImage}" />
    <script type="application/ld+json">${JSON.stringify(jsonLD)}</script>
    <meta http-equiv="refresh" content="0; url=${frontendUrl}" />
</head>
<body>
    <p>Mengalihkan ke produk... <a href="${frontendUrl}">Klik di sini</a></p>
</body>
</html>`;

    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);

  } catch (e) {
    console.error(e);
    res.status(500).send('<h1>Terjadi kesalahan server</h1>');
  }
});

module.exports = router;
