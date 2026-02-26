// app.js — Vercel-compatible
require('dotenv').config({ debug: false, quiet: true });

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const Manga   = require('./models/Manga');
const Chapter = require('./models/Chapter');
const apiRoutes = require('./routes/api');

const app = express();

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// ── DATABASE CONNECTION (lazy + cached untuk Vercel) ──────────────
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  const DB_URI = process.env.DB_URI;
  if (!DB_URI) throw new Error('DB_URI tidak terdefinisi!');
  await mongoose.connect(DB_URI, { serverSelectionTimeoutMS: 30000 });
  isConnected = true;
  console.log('MongoDB connected');
}

// Middleware DB — berlaku untuk SEMUA route termasuk webhook
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('DB Error:', err.message);
    res.status(503).json({ success: false, message: 'Database tidak tersedia.' });
  }
});

// ── TELEGRAM WEBHOOK ──────────────────────────────────────────────
// Didaftarkan SETELAH middleware DB agar MongoDB sudah connect
const { handleUpdate } = require('./bot/telegram');

app.post('/api/telegram/webhook', async (req, res) => {
  // Balas 200 dulu ke Telegram agar tidak retry
  res.sendStatus(200);
  // Proses update async (DB sudah pasti connect di sini)
  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error('[Webhook] Error:', err.message);
  }
});

// ── API ROUTES ────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// ── LOCAL DEV ─────────────────────────────────────────────────────
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  connectDB().then(() => {
    app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
  }).catch(err => { console.error(err); process.exit(1); });
}

module.exports = app;
