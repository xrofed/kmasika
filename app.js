// app.js — Vercel-compatible (export app, jangan listen)
require('dotenv').config({ debug: false, quiet: true });

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const Manga = require('./models/Manga');
const Chapter = require('./models/Chapter');
const apiRoutes = require('./routes/api');

const app = express();
const WEBSITE_URL = process.env.SITE_URL || 'http://localhost:3000';

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use('/api', apiRoutes);

// ── DATABASE CONNECTION (lazy — connect sekali, cache di Vercel) ──
let isConnected = false;

async function connectDB() {
  if (isConnected) return;

  const DB_URI = process.env.DB_URI;
  if (!DB_URI) throw new Error('DB_URI tidak terdefinisi di environment variables!');

  await mongoose.connect(DB_URI, { serverSelectionTimeoutMS: 30000 });
  isConnected = true;
  console.log('MongoDB connected');
}

// Middleware: konek DB sebelum setiap request (Vercel serverless pattern)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('DB Connection Error:', err.message);
    res.status(503).json({ success: false, message: 'Database tidak tersedia.' });
  }
});

// ── JALANKAN BOT WA HANYA DI LUAR VERCEL ─────────────────────────
// Vercel = serverless, tidak bisa jalankan proses persisten (Puppeteer/WA)
const isVercel = !!process.env.VERCEL;

if (!isVercel) {
  const { initWhatsAppBot } = require('./bot/whatsapp');
  const PORT = process.env.PORT || 3000;

  connectDB().then(() => {
    app.listen(PORT, () => {
      console.log(`Server berjalan di port ${PORT} — ${WEBSITE_URL}`);
      initWhatsAppBot();
    });
  }).catch(err => {
    console.error('Gagal koneksi DB, server tidak jalan:', err);
    process.exit(1);
  });
}

// ── EXPORT untuk Vercel ───────────────────────────────────────────
module.exports = app;
