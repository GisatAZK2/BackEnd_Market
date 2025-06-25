const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const key = crypto.randomBytes(32).toString('hex');
const keyPath = path.join(__dirname, 'keys.json');

// Load existing keys
let keys = [];
if (fs.existsSync(keyPath)) {
  keys = JSON.parse(fs.readFileSync(keyPath));
}

// Tambahkan key baru
keys.push({ key, createdAt: new Date(), active: true });

// Simpan kembali ke file
fs.writeFileSync(keyPath, JSON.stringify(keys, null, 2));

console.log('API Key generated:\n', key);
