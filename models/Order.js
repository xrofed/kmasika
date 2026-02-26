// models/Order.js
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  // Identifikasi
  telegramUserId: { type: String, required: true },
  telegramUsername: { type: String, default: '' },
  telegramFirstName: { type: String, default: '' },
  googleId: { type: String, required: true },

  // Paket
  paketId: { type: String, required: true },    // '1' atau '2'
  paketNama: { type: String, required: true },
  paketHarga: { type: String, required: true },
  paketDurasi: { type: Number, required: true }, // hari

  // Validasi nominal
  nominalDibayar: { type: Number, default: null }, // yang user klaim
  nominalValid: { type: Boolean, default: false },

  // Status
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'rejected'],
    default: 'pending',
  },

  // Bukti bayar (file_id dari Telegram)
  buktiBayarFileId: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

orderSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Index agar query cepat
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ telegramUserId: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);
