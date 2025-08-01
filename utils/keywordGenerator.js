
function generateKeywords(text) {
  if (!text || typeof text !== 'string') return [];

  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/gi, '')  // hapus karakter aneh
        .split(/\s+/)                  // split spasi
        .filter(word => word.length > 1) // minimal 2 huruf
    )
  );
}

module.exports = { generateKeywords };
