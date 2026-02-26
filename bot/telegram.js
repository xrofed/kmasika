/**
 * =============================================
 * Telegram Bot — Doujin Desu Premium (FIXED)
 * ✅ Deep Linking Support (dari App Flutter)
 * ✅ Premium Extension Logic (Menambah durasi)
 * ✅ Webhook & Database Optimized
 * =============================================
 */

const axios = require('axios');
const Order = require('../models/Order');
const User = require('../models/User');

// ─── KONFIGURASI ─────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) {
  console.error('[TG] ⚠️ TELEGRAM_BOT_TOKEN tidak diset! Bot tidak akan berfungsi.');
}

// Konfigurasi Paket
const PAKET = {
  '1': { nama: 'Paket 7 Hari', harga: 'Rp 5.000', nominal: 5000, durasi: 7 },
  '2': { nama: 'Paket 30 Hari', harga: 'Rp 15.000', nominal: 15000, durasi: 30 },
};

// ─── TELEGRAM API HELPERS ────────────────────────────────────────

async function sendMessage(chatId, text, extra = {}) {
  try {
    await axios.post(`${BASE_URL}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...extra,
    });
  } catch (err) {
    console.error('[TG] sendMessage error:', err.response?.data?.description || err.message);
  }
}

async function sendPhoto(chatId, fileIdOrUrl, caption = '', extra = {}) {
  try {
    await axios.post(`${BASE_URL}/sendPhoto`, {
      chat_id: chatId,
      photo: fileIdOrUrl,
      caption,
      parse_mode: 'HTML',
      ...extra,
    });
  } catch (err) {
    console.error('[TG] sendPhoto error:', err.response?.data?.description || err.message);
  }
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    await axios.post(`${BASE_URL}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
    });
  } catch (err) {
    // Ignore error (biasanya karena timeout)
  }
}

async function editMessageText(chatId, messageId, text, extra = {}) {
  try {
    await axios.post(`${BASE_URL}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...extra,
    });
  } catch (err) {
    console.error('[TG] editMessage error:', err.message);
  }
}

// ─── SESSION MANAGEMENT ──────────────────────────────────────────
// Mengambil order yang statusnya masih 'waiting_*' (belum selesai)
async function getSession(telegramUserId) {
  const inProgress = await Order.findOne({
    telegramUserId: String(telegramUserId),
    status: { $in: ['waiting_googleid', 'waiting_bukti', 'waiting_nominal'] },
  }).sort({ createdAt: -1 });

  return inProgress;
}

// ─── MAIN WEBHOOK HANDLER ────────────────────────────────────────

async function handleUpdate(update) {
  if (!update) return;

  // 1. Handle Tombol Inline (Callback Query)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = (msg.text || '').trim();
  const textLow = text.toLowerCase();

  // 2. Handle Deep Linking (Dari tombol "Beli" di Flutter)
  // Format: /start paket_1
  if (textLow.startsWith('/start paket_')) {
    const paketId = textLow.split('paket_')[1];
    await prosesPilihPaket(chatId, userId, msg.from, paketId);
    return;
  }

  // 3. Cek Sesi Aktif (User sedang dalam proses order)
  const session = await getSession(userId);

  // ── STEP 1: WAITING GOOGLE ID ────────────────────────────────
  if (session?.status === 'waiting_googleid') {
    // Validasi panjang ID (UID Firebase biasanya panjang)
    if (text.length < 5) {
      await sendMessage(chatId,
        `⚠️ <b>ID Terlalu Pendek</b>\n\n` +
        `Mohon salin <b>Google ID</b> (UID) langsung dari aplikasi.\n` +
        `<i>Buka App → Profil → Salin ID di bawah email.</i>`
      );
      return;
    }

    session.googleId = text;
    session.status = 'waiting_bukti';
    session.telegramUsername = msg.from.username || '';
    session.telegramFirstName = msg.from.first_name || '';
    await session.save();

    const paket = PAKET[session.paketId];
    await sendMessage(chatId,
      `✅ <b>Google ID Disimpan!</b>\n` +
      `🆔 <code>${text}</code>\n\n` +
      `📦 <b>${paket.nama}</b> — ${paket.harga}\n\n` +
      `👇 <b>Langkah Selanjutnya:</b>\n` +
      `1. Scan QRIS di bawah ini.\n` +
      `2. Transfer sesuai nominal.\n` +
      `3. Kirim <b>FOTO BUKTI TRANSFER</b> ke sini.`
    );

    // Kirim QRIS
    await kirimQRIS(chatId, paket);
    return;
  }

  // ── STEP 2: WAITING BUKTI BAYAR ──────────────────────────────
  if (session?.status === 'waiting_bukti') {
    const hasPhoto = msg.photo && msg.photo.length > 0;

    // Jika user mengirim teks "batal"
    if (textLow === 'batal' || textLow === '/batal') {
      session.status = 'rejected';
      await session.save();
      await sendMessage(chatId, '❌ Pesanan dibatalkan. Ketik /beli untuk pesan baru.');
      return;
    }

    if (!hasPhoto) {
      await sendMessage(chatId,
        `📸 Mohon kirimkan <b>Foto/Screenshot</b> bukti transfer.\n` +
        `Atau ketik /batal untuk membatalkan.`
      );
      return;
    }

    // Ambil foto resolusi tertinggi (index terakhir)
    session.buktiBayarFileId = msg.photo[msg.photo.length - 1].file_id;
    session.status = 'waiting_nominal';
    await session.save();

    const paket = PAKET[session.paketId];
    await sendMessage(chatId,
      `💰 <b>Verifikasi Nominal</b>\n\n` +
      `Berapa nominal yang kamu transfer?\n` +
      `Harga Paket: <b>${paket.harga}</b>\n\n` +
      `Ketik angkanya saja. Contoh: <code>${paket.nominal}</code>`
    );
    return;
  }

  // ── STEP 3: WAITING NOMINAL ──────────────────────────────────
  if (session?.status === 'waiting_nominal') {
    // Bersihkan input dari "Rp", titik, koma, spasi
    const cleaned = text.replace(/[^0-9]/g, '');
    const nominal = parseInt(cleaned, 10);

    if (isNaN(nominal) || nominal <= 0) {
      await sendMessage(chatId,
        `⚠️ <b>Format Salah</b>\nKetik angka saja tanpa titik/koma. Contoh: <code>${PAKET[session.paketId].nominal}</code>`
      );
      return;
    }

    const paket = PAKET[session.paketId];
    session.nominalDibayar = nominal;
    session.nominalValid = nominal >= (paket.nominal - 500); // Toleransi kurang 500 perak
    session.status = 'pending';
    await session.save();

    // Logika Tolak Otomatis jika Nominal Jauh di Bawah Harga
    if (!session.nominalValid) {
      await sendMessage(chatId,
        `❌ <b>Nominal Tidak Sesuai</b>\n\n` +
        `Kamu memasukkan: <b>Rp ${nominal.toLocaleString('id-ID')}</b>\n` +
        `Harga seharusnya: <b>${paket.harga}</b>\n\n` +
        `Pesanan dibatalkan otomatis. Jika ini kesalahan, silakan hubungi admin.`
      );
      session.status = 'rejected';
      await session.save();

      // Notif admin (opsional, untuk pantauan)
      await notifikasiAdmin(session, chatId, true);
      return;
    }

    // Sukses -> Masuk Antrian Admin
    await sendMessage(chatId,
      `✅ <b>Pesanan Diterima!</b>\n\n` +
      `Data sedang diverifikasi admin. Premium akan aktif otomatis dalam <b>1-5 menit</b>.\n` +
      `Kami akan mengirim notifikasi ke sini setelah aktif. 👌`
    );

    await notifikasiAdmin(session, chatId);
    return;
  }

  // ── COMMANDS & MENU ──────────────────────────────────────────
  const triggers = ['/start', '/beli', 'halo', 'premium', 'menu'];
  if (triggers.some(t => textLow.startsWith(t))) {
    await sendMenu(chatId, msg.from.first_name || 'Kak');
    return;
  }

  if (textLow === '/status') {
    await handleStatus(chatId, userId);
    return;
  }

  // Fallback Message
  await sendMessage(chatId,
    `🤖 Ini adalah Bot Pembayaran Otomatis.\n\n` +
    `Ketik /beli untuk membeli paket.\n` +
    `Ketik /status untuk cek status pesanan.`
  );
}

// ─── LOGIKA UTAMA ────────────────────────────────────────────────

// Helper: Menampilkan Menu Paket
async function sendMenu(chatId, firstName) {
  await sendMessage(chatId,
    `👋 Halo <b>${firstName}</b>!\n\n` +
    `Ingin upgrade ke <b>Doujin Desu Premium</b>?\n` +
    `Pilih paket di bawah ini untuk memulai:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📦 Paket 7 Hari — Rp 5.000', callback_data: 'paket_1' }],
          [{ text: '⭐ Paket 30 Hari — Rp 15.000 (HEMAT)', callback_data: 'paket_2' }],
        ],
      },
    }
  );
}

// Helper: Proses Pemilihan Paket (Dipakai oleh Inline Button & Deep Link)
async function prosesPilihPaket(chatId, userId, telegramUser, paketId) {
  const paket = PAKET[paketId];
  if (!paket) {
    await sendMessage(chatId, '❌ Paket tidak ditemukan.');
    return;
  }

  // Cek apakah user masih punya order 'nanggung'
  const existing = await Order.findOne({
    telegramUserId: String(userId),
    status: { $in: ['waiting_googleid', 'waiting_bukti', 'waiting_nominal', 'pending'] },
  });

  if (existing) {
    let statusMsg = '';
    if (existing.status === 'pending') statusMsg = 'sedang menunggu konfirmasi admin';
    else statusMsg = 'belum diselesaikan';

    await sendMessage(chatId,
      `⚠️ <b>Ada Transaksi Berjalan</b>\n\n` +
      `Kamu memiliki pesanan <b>${existing.paketNama}</b> yang ${statusMsg}.\n` +
      `Selesaikan dulu atau ketik /batal untuk membuat baru.`
    );
    return;
  }

  // Buat Order Baru
  await Order.create({
    telegramUserId: String(userId),
    telegramUsername: telegramUser.username || '',
    telegramFirstName: telegramUser.first_name || '',
    googleId: '', // Nanti diisi user
    paketId,
    paketNama: paket.nama,
    paketHarga: paket.harga,
    paketDurasi: paket.durasi,
    status: 'waiting_googleid',
  });

  await sendMessage(chatId,
    `📦 <b>${paket.nama} dipilih!</b>\n` +
    `Harga: <b>${paket.harga}</b>\n\n` +
    `Satu langkah lagi! Kirimkan <b>Google ID</b> (UID) akun kamu.\n` +
    `<i>(Buka Aplikasi → Profil → Salin ID)</i>`
  );
}

// ─── CALLBACK QUERY HANDLER ──────────────────────────────────────
async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const userId = String(callbackQuery.from.id);

  await answerCallbackQuery(callbackQuery.id);

  if (data.startsWith('paket_')) {
    const paketId = data.replace('paket_', '');
    await prosesPilihPaket(chatId, userId, callbackQuery.from, paketId);
  }
}

// ─── UTILITIES ───────────────────────────────────────────────────

async function handleStatus(chatId, userId) {
  const order = await Order.findOne({ telegramUserId: userId }).sort({ createdAt: -1 });

  if (!order) {
    await sendMessage(chatId, `Belum ada riwayat pesanan.`);
    return;
  }

  const mapStatus = {
    waiting_googleid: '⌨️ Menunggu Input ID',
    waiting_bukti: '📸 Menunggu Bukti Bayar',
    waiting_nominal: '💰 Menunggu Input Nominal',
    pending: '⏳ Menunggu Konfirmasi Admin',
    confirmed: '✅ Selesai (Aktif)',
    rejected: '❌ Ditolak/Batal',
  };

  await sendMessage(chatId,
    `🧾 <b>Status Pesanan Terakhir</b>\n\n` +
    `📦 Paket: ${order.paketNama}\n` +
    `📅 Tanggal: ${order.createdAt.toLocaleDateString('id-ID')}\n` +
    `📊 Status: <b>${mapStatus[order.status] || order.status}</b>\n` +
    `🆔 Google ID: <code>${order.googleId || '-'}</code>`
  );
}

async function kirimQRIS(chatId, paket) {
  const qrisFileId = process.env.TELEGRAM_QRIS_FILE_ID;
  const siteUrl = process.env.SITE_URL;

  // Prioritas 1: File ID (Cepat)
  if (qrisFileId) {
    await sendPhoto(chatId, qrisFileId, `📲 Scan QRIS • ${paket.harga}`);
    return;
  }

  // Prioritas 2: URL Public (Pastikan qris.png ada di folder public)
  if (siteUrl) {
    const qrisUrl = `${siteUrl.replace(/\/$/, '')}/qris.png`; // Hapus trailing slash
    await sendPhoto(chatId, qrisUrl, `📲 Scan QRIS • ${paket.harga}`);
  } else {
    await sendMessage(chatId, `⚠️ QRIS belum dikonfigurasi oleh admin.`);
  }
}

async function notifikasiAdmin(order, userChatId, isRejected = false) {
  if (!ADMIN_CHAT_ID) return;

  const statusIcon = isRejected ? '❌ AUTO REJECT' : '🔔 PESANAN BARU';

  const caption =
    `<b>${statusIcon}</b>\n\n` +
    `👤 <b>${order.telegramFirstName}</b> (@${order.telegramUsername || '-'}) \n` +
    `📦 ${order.paketNama} (${order.paketHarga})\n` +
    `🆔 <code>${order.googleId}</code>\n` +
    `💵 Input: Rp ${(order.nominalDibayar || 0).toLocaleString('id-ID')}\n` +
    `📅 ${new Date().toLocaleString('id-ID')}\n\n` +
    (isRejected ? '<i>Pesanan ini ditolak otomatis karena nominal kurang.</i>' : '👉 <b>Buka App Admin untuk Konfirmasi.</b>');

  if (order.buktiBayarFileId) {
    await sendPhoto(ADMIN_CHAT_ID, order.buktiBayarFileId, caption);
  } else {
    await sendMessage(ADMIN_CHAT_ID, caption);
  }
}

// ─── LOGIKA AKTIVASI PREMIUM (Diperbaiki) ────────────────────────
async function aktivasiPremiumById(orderId) {
  try {
    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: 'Order hilang' };
    if (order.status !== 'pending') return { success: false, message: 'Order sudah diproses' };

    // Cari User
    const user = await User.findOne({ googleId: order.googleId });
    if (!user) return { success: false, message: 'Google ID tidak ditemukan di database User' };

    // LOGIKA PERPANJANGAN (FIX)
    // Jika user masih premium, tambah hari dari tanggal expired terakhir
    // Jika tidak, mulai dari hari ini
    let startDate = new Date();
    if (user.isPremium && user.premiumUntil) {
      if (user.premiumUntil > startDate) {
        startDate = user.premiumUntil; // Extend
      }
    }

    // Hitung tanggal kadaluarsa baru
    const newExpDate = new Date(startDate);
    newExpDate.setDate(newExpDate.getDate() + order.paketDurasi);

    // Update User
    user.isPremium = true;
    user.premiumUntil = newExpDate;

    // Tambah Notifikasi di App
    if (!user.notifications) user.notifications = [];
    user.notifications.push({
      title: 'Premium Aktif! 🎉',
      message: `Terima kasih! Paket ${order.paketNama} (${order.paketDurasi} hari) berhasil diaktifkan.`,
      isRead: false,
      createdAt: new Date(),
    });

    await user.save();

    // Update Order jadi Confirmed
    order.status = 'confirmed';
    await order.save();

    return { success: true, order, newExpDate };

  } catch (err) {
    console.error('[TG] Aktivasi Error:', err.message);
    return { success: false, message: err.message };
  }
}

// ─── API EXPORTS (Untuk Dipanggil Route Lain) ────────────────────

async function getPendingOrders() {
  const orders = await Order.find({ status: 'pending' }).sort({ createdAt: -1 }).lean();
  return orders.map(o => ({
    orderKey: o._id.toString(),
    telegramUsername: o.telegramUsername || o.telegramFirstName,
    googleId: o.googleId,
    paketNama: o.paketNama,
    paketHarga: o.paketHarga,
    paketDurasi: o.paketDurasi,
    nominalDibayar: o.nominalDibayar,
    nominalValid: o.nominalValid,
    timestamp: o.createdAt.getTime(),
  }));
}

async function confirmOrderFromApp(orderId) {
  const result = await aktivasiPremiumById(orderId);

  if (result.success) {
    // Kirim notifikasi sukses ke Telegram User
    const expStr = result.newExpDate.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    await sendMessage(result.order.telegramUserId,
      `🎉 <b>Selamat! Premium Aktif</b>\n\n` +
      `Paket: <b>${result.order.paketNama}</b>\n` +
      `Berlaku sampai: <b>${expStr}</b>\n\n` +
      `Terima kasih sudah mendukung kami! Silakan restart aplikasi jika fitur belum terbuka. 🚀`
    );
  }
  return result;
}

async function rejectOrderFromApp(orderId) {
  try {
    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: 'Order tidak ditemukan' };

    order.status = 'rejected';
    await order.save();

    // Notif ke User
    await sendMessage(order.telegramUserId,
      `❌ <b>Pembayaran Ditolak</b>\n\n` +
      `Admin tidak dapat memverifikasi pembayaranmu.\n` +
      `Dana mungkin kurang atau bukti transfer tidak jelas.\n` +
      `Silakan hubungi admin jika ini kesalahan.`
    );

    return { success: true, message: 'Order ditolak' };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function setupWebhook(webhookUrl) {
  try {
    await axios.post(`${BASE_URL}/setWebhook`, { url: webhookUrl });
    console.log(`[TG] Webhook set to: ${webhookUrl}`);
  } catch (e) {
    console.error('[TG] Webhook Fail:', e.message);
  }
}

module.exports = {
  handleUpdate,
  setupWebhook,
  getPendingOrders,
  confirmOrderFromApp,
  rejectOrderFromApp
};