// models/Order.js
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  // Identifikasi User Telegram
  telegramUserId: { 
    type: String, 
    required: true 
  },
  telegramUsername: { 
    type: String, 
    default: '' 
  },
  telegramFirstName: { 
    type: String, 
    default: '' 
  },
  
  // Google ID dari aplikasi (diisi di tahap kedua)
  // Required dihapus agar bisa membuat draft order di awal
  googleId: { 
    type: String, 
    default: '' 
  },

  // Informasi Paket
  paketId: { 
    type: String, 
    required: true 
  },    // '1' atau '2'
  paketNama: { 
    type: String, 
    required: true 
  },
  paketHarga: { 
    type: String, 
    required: true 
  },
  paketDurasi: { 
    type: Number, 
    required: true 
  }, // dalam jumlah hari

  // Validasi Nominal Pembayaran
  nominalDibayar: { 
    type: Number, 
    default: null 
  }, // nominal yang diklaim user
  nominalValid: { 
    type: Boolean, 
    default: false 
  },

  // Status Alur Pesanan
  // Menambahkan status 'waiting_*' agar validasi enum tidak error saat proses input
  status: {
    type: String,
    enum: [
      'waiting_googleid', 
      'waiting_bukti', 
      'waiting_nominal', 
      'pending', 
      'confirmed', 
      'rejected'
    ],
    default: 'waiting_googleid',
  },

  // Bukti bayar (file_id dari server Telegram)
  buktiBayarFileId: { 
    type: String, 
    default: null 
  },

  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  },
});

// Middleware untuk memperbarui field updatedAt secara otomatis sebelum disimpan
orderSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Indexing untuk mempercepat query pencarian status dan user
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ telegramUserId: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);