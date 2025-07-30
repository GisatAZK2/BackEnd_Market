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
    } catch (e) {
      ogImage = product.product_image_url;
    }

    const ogUrl = `https://cihuy.sytes.net/detail/produk/${encodeURIComponent(product.product_name)}/${id}`;
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
        "url": ogUrl,
        "availability": "https://schema.org/InStock"
      }
    };

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
    <meta property="og:url" content="${ogUrl}" />
    <meta property="og:type" content="product" />
    <meta property="og:site_name" content="CIHUY STORE" />
    <link rel="canonical" href="${ogUrl}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${product.product_name}" />
    <meta name="twitter:description" content="${product.product_description || ''}" />
    <meta name="twitter:image" content="${ogImage}" />
    <script type="application/ld+json">${JSON.stringify(jsonLD)}</script>
</head>
<body>
    <h1>${product.product_name}</h1>
    <p>${product.product_description || ''}</p>
    ${ogImage ? `<img src="${ogImage}" alt="${product.product_name}" style="max-width:400px" />` : ''}
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
