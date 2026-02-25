// app.js - FINAL VERSION (FIXED)
require('dotenv').config({
debug: false, quiet: true
});
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
// Tidak perlu import model di app.js jika tidak digunakan langsung di sini, 
// tapi aku biarkan saja agar tidak mengubah kodemu terlalu banyak.
const Manga = require('./models/Manga'); 
const Chapter = require('./models/Chapter');

// IMPORT RUTE API (PENTING)
const apiRoutes = require('./routes/api');

// IMPORT WHATSAPP BOT
const { initWhatsAppBot } = require('./bot/whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;
const WEBSITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

// ==========================================
// MIDDLEWARE (TAMBAHAN PENTING UNTUK BACA JSON DARI FLUTTER)
// ==========================================
app.use(express.json()); // Membaca tipe application/json
app.use(express.urlencoded({ extended: true })); // Membaca tipe application/x-www-form-urlencoded

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// PASTIKAN API ROUTE ADA DI BAWAH MIDDLEWARE EXPRESS.JSON
app.use('/api', apiRoutes);

// ==========================================
// SERVER STARTUP
// ==========================================

const DB_URI = process.env.DB_URI;

if (!DB_URI) {
console.error("FATAL ERROR: DB_URI is not defined in environment variables.");
process.exit(1);
}

const startServer = async () => {
try {
await mongoose.connect(DB_URI, {
serverSelectionTimeoutMS: 30000
});
console.log('Successfully connected to MongoDB...');

app.listen(PORT, () => {
console.log(`Server is running on port: ${PORT}`);
console.log(`Access at: ${WEBSITE_URL}`);

// Jalankan WhatsApp Bot setelah server siap
initWhatsAppBot();
});

} catch (err) {
console.error('Failed to connect to MongoDB. Server will not start.', err);
process.exit(1);
}
};

startServer();
