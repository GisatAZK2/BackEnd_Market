const sharp = require("sharp");

async function convertToWebp(buffer, quality = 80) {
  return sharp(buffer)
    .webp({ quality, effort: 6 }) // effort=6 agak optimal
    .toBuffer();
}

module.exports = { convertToWebp };
