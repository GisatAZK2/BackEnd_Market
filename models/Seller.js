const mongoose = require('mongoose');

const SellerSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name: String,
  businessName: String,
  phone: String,
  storeName: String,
  storeAddress: String,
  addressComponents: {
    kelurahan: String,
    kecamatan: String,
    kabupaten: String,
    provinsi: String
  },
  storeLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true }
  },
  storeImageUrl: String,
  role: { type: String, default: 'seller' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Seller', SellerSchema);
