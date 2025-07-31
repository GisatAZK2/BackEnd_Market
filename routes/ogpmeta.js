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

    // Deteksi User-Agent (bot crawler vs manusia)
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isBot =
      ua.includes('whatsapp') ||
      ua.includes('facebook') ||
      ua.includes('discord') ||
      ua.includes('twitterbot') ||
      ua.includes('linkedin') ||
      ua.includes('telegram') ||
      ua.includes('slack') ||
      ua.includes('pinterest') ||
      ua.includes('instagram') ||
      ua.includes('googlebot') ||
      ua.includes('bingbot');

    const frontendUrl = `https://cihuy.sytes.net/detail/produk/${encodeURIComponent(product.product_name)}/${id}`;

    // Ambil gambar utama dari array JSON
    let ogImage = '';
    try {
      const parsed = JSON.parse(product.product_image_url);
      ogImage = Array.isArray(parsed) ? parsed[0] : product.product_image_url;
    } catch (e) {
      ogImage = product.product_image_url;
    }

    // JSON-LD Schema.org untuk SEO Google
    const jsonLD = {
      "@context": "https://schema.org/",
      "@type": "Product",
      "name": product.product_name,
      "description": product.product_description || "",
      "image": ogImage,
      "sku": id,
      "brand": {
        "@type": "Brand",
        "name": "CIHUY STORE"
      },
      "offers": {
        "@type": "Offer",
        "url": frontendUrl,
        "priceCurrency": "IDR",
        "price": product.product_price || "10000",
        "availability": "https://schema.org/InStock",
        "itemCondition": "https://schema.org/NewCondition"
      }
    };

    if (isBot) {
      // === Untuk bot sosial media dan Google ===
      const html = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>${product.product_name}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${product.product_description || ''}" />
  <meta name="robots" content="index, follow" />
  <meta name="author" content="CIHUY STORE" />
  <meta name="keywords" content="${product.product_name}, jual ${product.product_name}, beli ${product.product_name}, ${product.product_description?.split(' ').slice(0, 5).join(', ') || ''}" />
  <link rel="canonical" href="${frontendUrl}" />

  <!-- Open Graph untuk Facebook, LinkedIn, Discord, dll -->
  <meta property="og:title" content="${product.product_name}" />
  <meta property="og:description" content="${product.product_description || ''}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="600" />
  <meta property="og:image:height" content="600" />
  <meta property="og:url" content="${frontendUrl}" />
  <meta property="og:type" content="product" />
  <meta property="og:site_name" content="CIHUY STORE" />
  <meta property="og:locale" content="id_ID" />
  <meta property="product:brand" content="CIHUY STORE" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@cihuystore" />
  <meta name="twitter:creator" content="@cihuystore" />
  <meta name="twitter:title" content="${product.product_name}" />
  <meta name="twitter:description" content="${product.product_description || ''}" />
  <meta name="twitter:image" content="${ogImage}" />

  <!-- Tambahan Universal -->
  <meta name="application-name" content="CIHUY STORE" />
  <meta name="theme-color" content="#ffffff" />

  <!-- Structured Data JSON-LD -->
  <script type="application/ld+json">${JSON.stringify(jsonLD)}</script>
</head>
<body>
  <h1>${product.product_name}</h1>
  <p>${product.product_description || ''}</p>
  ${ogImage ? `<img src="${ogImage}" alt="${product.product_name}" style="max-width:400px" />` : ''}
</body>
</html>`;
      res.send(html);
    } else {
      // === Redirect user biasa ke frontend ===
      res.redirect(frontendUrl);
    }
  } catch (e) {
    console.error(e);
    res.status(500).send('<h1>Terjadi kesalahan server</h1>');
  }
});

module.exports = router;
