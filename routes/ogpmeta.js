const express = require('express');
const supabase = require('../config/supabase');
const router = express.Router();

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: product, error } = await supabase
      .from('products')
      .select('*, seller:sellers(name)') // relasi ke seller
      .eq('id', id)
      .single();

    if (error || !product) {
      return res.status(404).send('<h1>❌ Produk tidak ditemukan</h1>');
    }

    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isBot = [
      'whatsapp', 'facebook', 'discord', 'twitterbot', 'linkedin',
      'telegram', 'slack', 'pinterest', 'instagram', 'googlebot', 'bingbot'
    ].some(agent => ua.includes(agent));

    const frontendUrl = `https://cihuy.sytes.net/detail/produk/${encodeURIComponent(product.product_name)}/${id}`;

    // OG image: gunakan gambar produk jika ada, fallback ke logo toko
    let ogImage = 'https://hihfiptclwrwuklojdec.supabase.co/storage/v1/object/public/store-photos/BG-Logo-Aplikasi.png';
    try {
      const parsed = JSON.parse(product.product_image_url);
      if (Array.isArray(parsed) && parsed.length > 0) {
        ogImage = parsed[0];
      }
    } catch (e) {
      if (product.product_image_url) ogImage = product.product_image_url;
    }

    const pageTitle = `CIHUY STORE - ${product.product_name} oleh ${product.seller?.name || 'Penjual'}`;
    const description = product.product_description || 'Produk terbaik dari Cihuy Store';

    const jsonLD = {
      "@context": "https://schema.org/",
      "@type": "Product",
      "name": product.product_name,
      "description": description,
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
      },
      "seller": {
        "@type": "Organization",
        "name": product.seller?.name || "CIHUY SELLER"
      }
    };

    if (isBot) {
      // ✅ META tag lengkap untuk SEO + sosial media
      const html = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>${pageTitle}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${description}" />
  <meta name="robots" content="index, follow" />
  <meta name="author" content="CIHUY STORE" />
  <meta name="keywords" content="${product.product_name}, jual ${product.product_name}, beli ${product.product_name}" />
  <link rel="canonical" href="${frontendUrl}" />

  <!-- ✅ Open Graph / Facebook / WhatsApp -->
  <meta property="og:title" content="${pageTitle}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="600" />
  <meta property="og:image:height" content="600" />
  <meta property="og:url" content="${frontendUrl}" />
  <meta property="og:type" content="product" />
  <meta property="og:site_name" content="CIHUY STORE" />
  <meta property="product:brand" content="CIHUY STORE" />

  <!-- ✅ Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@cihuy" />
  <meta name="twitter:title" content="${pageTitle}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${ogImage}" />

  <!-- ✅ Telegram / Discord / Slack -->
  <meta name="theme-color" content="#f97316" />
  <meta name="application-name" content="CIHUY STORE" />

  <!-- ✅ JSON-LD (SEO Google) -->
  <script type="application/ld+json">${JSON.stringify(jsonLD)}</script>
</head>
<body>
  <h1>${pageTitle}</h1>
  <p>${description}</p>
  <img src="${ogImage}" alt="${product.product_name}" style="max-width:400px" />
</body>
</html>`;
      res.send(html);
    } else {
      // Redirect ke halaman frontend jika bukan bot
      res.redirect(frontendUrl);
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('<h1>Terjadi kesalahan server</h1>');
  }
});

module.exports = router;
