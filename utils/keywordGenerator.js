// utils/keywordGenerator.js
module.exports = function generateKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // buang simbol
    .split(/\s+/)            // pecah kata
    .filter(Boolean);        // hapus kosong
};
