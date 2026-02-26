/**
 * =============================================
 *  Telegram Bot — Doujin Desu Premium
 *  ✅ Webhook-based (Vercel compatible)
 *  ✅ Pending orders disimpan di MongoDB
 *  ✅ Validasi nominal pembayaran
 *  ✅ Admin konfirmasi via Telegram inline button
 *  ✅ Admin konfirmasi via Flutter app
 * =============================================
 */

const axios = require('axios');
const Order = require('../models/Order');
const User = require('../models/User');

// ─── KONFIGURASI ─────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID; // Chat ID admin Telegram
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

const PAKET = {
  '1': { nama: 'Paket 7 Hari',  harga: 'Rp 5.000',  nominal: 5000,  durasi: 7  },
  '2': { nama: 'Paket 30 Hari', harga: 'Rp 15.000', nominal: 15000, durasi: 30 },
};

// ─── TELEGRAM API HELPERS ────────────────────────────────────────

async function sendMessage(chatId, text, extra = {}) {
  try {
    await axios.post(`${BASE_URL}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...extra,
    });
  } catch (err) {
    console.error('[TG] sendMessage error:', err.response?.data || err.message);
  }
}

async function sendPhoto(chatId, fileIdOrUrl, caption = '', extra = {}) {
  try {
    await axios.post(`${BASE_URL}/sendPhoto`, {
      chat_id: chatId,
      photo: fileIdOrUrl,
      caption,
      parse_mode: 'Markdown',
      ...extra,
    });
  } catch (err) {
    console.error('[TG] sendPhoto error:', err.response?.data || err.message);
  }
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    await axios.post(`${BASE_URL}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
    });
  } catch (err) {
    console.error('[TG] answerCallback error:', err.message);
  }
}

async function editMessageText(chatId, messageId, text, extra = {}) {
  try {
    await axios.post(`${BASE_URL}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      ...extra,
    });
  } catch (err) {
    console.error('[TG] editMessage error:', err.message);
  }
}

// ─── SESSION (per user, simpan step di DB order terbaru) ─────────
// Karena Vercel serverless, session disimpan di MongoDB (field status order)

// Ambil session user: cari order "waiting_*" atau "asking_*"
async function getSession(telegramUserId) {
  // Cek apakah ada order yg masih dalam proses input
  const inProgress = await Order.findOne({
    telegramUserId: String(telegramUserId),
    status: { $in: ['waiting_googleid', 'waiting_bukti', 'waiting_nominal'] },
  }).sort({ createdAt: -1 });

  if (inProgress) return inProgress;
  return null;
}

// ─── MAIN WEBHOOK HANDLER ────────────────────────────────────────

async function handleUpdate(update) {
  // Handle callback query (tombol inline dari admin)
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

  // Cek apakah ada sesi aktif (order yang belum selesai)
  const session = await getSession(userId);

  // ── STEP: WAITING GOOGLE ID ──────────────────────────────────
  if (session?.status === 'waiting_googleid') {
    if (text.length < 10) {
      await sendMessage(chatId,
        `⚠️ Google ID tidak valid. Salin tepat dari aplikasi.\n\nCara cek: *Buka app → Profil → salin ID di bawah email*`
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
      `✅ Google ID tersimpan!\n\n` +
      `📦 *${paket.nama}* — *${paket.harga}*\n\n` +
      `Silakan bayar via *QRIS* di bawah ini, lalu kirim *foto bukti transfer* ke sini.`
    );

    // Kirim QRIS
    await kirimQRIS(chatId, paket);
    return;
  }

  // ── STEP: WAITING BUKTI BAYAR ────────────────────────────────
  if (session?.status === 'waiting_bukti') {
    const hasPhoto = msg.photo && msg.photo.length > 0;

    if (!hasPhoto && !textLow.includes('sudah') && !textLow.includes('bayar') && !textLow.includes('transfer')) {
      await sendMessage(chatId,
        `⏳ Kirim *foto/screenshot bukti transfer* setelah selesai membayar.`
      );
      return;
    }

    // Simpan file_id foto jika ada
    if (hasPhoto) {
      session.buktiBayarFileId = msg.photo[msg.photo.length - 1].file_id;
    }

    // Minta konfirmasi nominal
    session.status = 'waiting_nominal';
    await session.save();

    const paket = PAKET[session.paketId];
    await sendMessage(chatId,
      `📋 *Verifikasi Nominal*\n\n` +
      `Harga paket: *${paket.harga}*\n\n` +
      `Ketik nominal yang kamu transfer (angka saja).\n` +
      `Contoh: \`${paket.nominal}\``
    );
    return;
  }

  // ── STEP: WAITING NOMINAL ────────────────────────────────────
  if (session?.status === 'waiting_nominal') {
    // Bersihkan input: hapus titik, koma, spasi, "rp", dll.
    const cleaned = text.replace(/[^0-9]/g, '');
    const nominal = parseInt(cleaned, 10);

    if (isNaN(nominal) || nominal <= 0) {
      await sendMessage(chatId,
        `⚠️ Format tidak valid. Ketik angka saja, contoh: \`${PAKET[session.paketId].nominal}\``
      );
      return;
    }

    const paket = PAKET[session.paketId];
    session.nominalDibayar = nominal;
    session.nominalValid = nominal >= paket.nominal;
    session.status = 'pending'; // sudah masuk antrian
    await session.save();

    if (!session.nominalValid) {
      // Nominal KURANG — tolak otomatis
      await sendMessage(chatId,
        `❌ *Pembayaran Tidak Valid*\n\n` +
        `Nominal yang kamu masukkan: *Rp ${nominal.toLocaleString('id-ID')}*\n` +
        `Harga paket: *${paket.harga}*\n\n` +
        `Nominal kurang dari harga paket. Pesanan dibatalkan otomatis.\n\n` +
        `Ketik /beli untuk mencoba lagi.`
      );

      session.status = 'rejected';
      await session.save();

      // Notif admin juga
      if (ADMIN_CHAT_ID) {
        await sendMessage(ADMIN_CHAT_ID,
          `⚠️ *Pembayaran Ditolak Otomatis*\n\n` +
          `👤 @${session.telegramUsername || session.telegramFirstName}\n` +
          `📦 ${paket.nama}\n` +
          `💰 Nominal klaim: Rp ${nominal.toLocaleString('id-ID')} (kurang dari ${paket.harga})`
        );
      }
      return;
    }

    // Nominal OK — kirim ke admin untuk konfirmasi akhir
    await sendMessage(chatId,
      `✅ *Nominal Sesuai!*\n\n` +
      `Pesananmu sedang diverifikasi admin.\n` +
      `Premium aktif dalam *1–5 menit* ⚡\n\n` +
      `Terima kasih sudah berlangganan *Doujin Desu Premium* 🎉`
    );

    await notifikasiAdmin(session, chatId);
    return;
  }

  // ── COMMAND / IDLE ───────────────────────────────────────────
  const triggers = ['/start', '/beli', 'halo', 'hai', 'premium', 'beli', 'mulai'];
  if (triggers.some(t => textLow === t || textLow.startsWith(t))) {
    await sendMenu(chatId, msg.from.first_name || 'kamu');
    return;
  }

  if (textLow === '/status') {
    await handleStatus(chatId, userId);
    return;
  }

  await sendMessage(chatId,
    `Ketik /beli untuk membeli Premium atau /status untuk cek status pesanan.`
  );
}

// ─── MENU UTAMA ──────────────────────────────────────────────────
async function sendMenu(chatId, firstName) {
  await sendMessage(chatId,
    `👋 Halo *${firstName}*! Selamat datang di *Doujin Desu Premium*\n\n` +
    `Pilih paket berlangganan:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📦 Paket 7 Hari — Rp 5.000', callback_data: 'paket_1' }],
          [{ text: '⭐ Paket 30 Hari — Rp 15.000 (PALING LARIS)', callback_data: 'paket_2' }],
        ],
      },
    }
  );
}

// ─── HANDLE TOMBOL INLINE ────────────────────────────────────────
async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const userId = String(callbackQuery.from.id);
  const msgId = callbackQuery.message.message_id;

  await answerCallbackQuery(callbackQuery.id);

  // User pilih paket
  if (data.startsWith('paket_')) {
    const paketId = data.replace('paket_', '');
    const paket = PAKET[paketId];
    if (!paket) return;

    // Cek apakah ada order pending sebelumnya
    const existing = await Order.findOne({
      telegramUserId: userId,
      status: { $in: ['waiting_googleid', 'waiting_bukti', 'waiting_nominal', 'pending'] },
    });

    if (existing) {
      await sendMessage(chatId,
        `⚠️ Kamu masih punya pesanan yang belum selesai.\n\nLanjutkan pesanan sebelumnya atau tunggu konfirmasi admin.`
      );
      return;
    }

    // Buat order baru dengan status waiting_googleid
    await Order.create({
      telegramUserId: userId,
      telegramUsername: callbackQuery.from.username || '',
      telegramFirstName: callbackQuery.from.first_name || '',
      googleId: '', // belum diisi
      paketId,
      paketNama: paket.nama,
      paketHarga: paket.harga,
      paketDurasi: paket.durasi,
      status: 'waiting_googleid',
    });

    await editMessageText(chatId, msgId,
      `📦 *${paket.nama}* — *${paket.harga}*\n\n` +
      `Untuk melanjutkan, kirimkan *Google ID* akun kamu.\n\n` +
      `📌 Cara cek: *Buka app → Profil → salin ID di bawah email*`
    );
    return;
  }

  // Admin: konfirmasi order
  if (data.startsWith('confirm_')) {
    await handleAdminConfirm(callbackQuery, data.replace('confirm_', ''));
    return;
  }

  // Admin: tolak order
  if (data.startsWith('reject_')) {
    await handleAdminReject(callbackQuery, data.replace('reject_', ''));
    return;
  }
}

// ─── STATUS PESANAN ──────────────────────────────────────────────
async function handleStatus(chatId, userId) {
  const order = await Order.findOne({ telegramUserId: userId })
    .sort({ createdAt: -1 });

  if (!order) {
    await sendMessage(chatId, `Belum ada pesanan. Ketik /beli untuk mulai.`);
    return;
  }

  const statusLabel = {
    waiting_googleid: '🔄 Menunggu Google ID',
    waiting_bukti: '🔄 Menunggu bukti bayar',
    waiting_nominal: '🔄 Menunggu input nominal',
    pending: '⏳ Menunggu konfirmasi admin',
    confirmed: '✅ Dikonfirmasi — Premium aktif',
    rejected: '❌ Ditolak',
  }[order.status] || order.status;

  await sendMessage(chatId,
    `📋 *Status Pesanan Terakhir*\n\n` +
    `📦 ${order.paketNama}\n` +
    `💰 ${order.paketHarga}\n` +
    `📊 Status: ${statusLabel}\n` +
    `🕐 ${order.createdAt.toLocaleString('id-ID')}`
  );
}

// ─── KIRIM QRIS ──────────────────────────────────────────────────
async function kirimQRIS(chatId, paket) {
  const qrisFileId = process.env.TELEGRAM_QRIS_FILE_ID;

  if (qrisFileId) {
    // Pakai file_id (lebih cepat, sudah di-cache Telegram)
    await sendPhoto(chatId, qrisFileId,
      `📲 *Scan QR ini untuk membayar via QRIS*\n` +
      `Nominal: *${paket.harga}*\n` +
      `_Mendukung semua e-wallet & mobile banking_`
    );
  } else {
    // Fallback: kirim URL gambar dari public folder
    const qrisUrl = `${process.env.SITE_URL}/qris.png`;
    await sendPhoto(chatId, qrisUrl,
      `📲 *Scan QR ini untuk membayar via QRIS*\n` +
      `Nominal: *${paket.harga}*\n` +
      `_Mendukung semua e-wallet & mobile banking_`
    );
  }
}

// ─── NOTIFIKASI ADMIN ────────────────────────────────────────────
async function notifikasiAdmin(order, userChatId) {
  if (!ADMIN_CHAT_ID) {
    console.warn('[TG] TELEGRAM_ADMIN_CHAT_ID tidak diset!');
    return;
  }

  const teks =
    `🔔 *Pesanan Baru — Verifikasi Diperlukan*\n\n` +
    `👤 User: @${order.telegramUsername || order.telegramFirstName} (ID: ${order.telegramUserId})\n` +
    `🆔 Google ID: \`${order.googleId}\`\n` +
    `📦 Paket: ${order.paketNama}\n` +
    `💰 Harga: ${order.paketHarga}\n` +
    `💵 Klaim bayar: *Rp ${(order.nominalDibayar || 0).toLocaleString('id-ID')}* ${order.nominalValid ? '✅' : '❌'}\n` +
    `🕐 ${new Date().toLocaleString('id-ID')}\n\n` +
    `*Cek bukti bayar di atas, lalu konfirmasi:*`;

  // Kirim bukti bayar dulu jika ada
  if (order.buktiBayarFileId) {
    await sendPhoto(ADMIN_CHAT_ID, order.buktiBayarFileId, `📎 Bukti bayar dari order \`${order._id}\``);
  }

  // Kirim teks + tombol konfirmasi
  await sendMessage(ADMIN_CHAT_ID, teks, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Konfirmasi & Aktifkan', callback_data: `confirm_${order._id}` },
          { text: '❌ Tolak', callback_data: `reject_${order._id}` },
        ],
      ],
    },
  });
}

// ─── ADMIN: KONFIRMASI ORDER ─────────────────────────────────────
async function handleAdminConfirm(callbackQuery, orderId) {
  const msgId = callbackQuery.message.message_id;
  const adminChatId = callbackQuery.message.chat.id;

  // Verifikasi bahwa yang klik adalah admin
  if (String(adminChatId) !== String(ADMIN_CHAT_ID)) {
    await answerCallbackQuery(callbackQuery.id, '⛔ Hanya admin yang bisa konfirmasi.');
    return;
  }

  const result = await aktivasiPremiumById(orderId);

  if (result.success) {
    // Update pesan admin
    await editMessageText(adminChatId, msgId,
      `✅ *Dikonfirmasi oleh admin*\n\n` +
      `Order ID: \`${orderId}\`\n` +
      `Google ID: \`${result.order.googleId}\`\n` +
      `Paket: ${result.order.paketNama}\n` +
      `Premium aktif sampai: *${getExpDate(result.order.paketDurasi)}*`
    );

    // Notif ke user
    await sendMessage(result.order.telegramUserId,
      `🎉 *Premium Aktif!*\n\n` +
      `Paket *${result.order.paketNama}* sudah diaktifkan!\n` +
      `Berlaku sampai: *${getExpDate(result.order.paketDurasi)}*\n\n` +
      `Selamat menikmati akses tanpa batas! 📚✨`
    );

    await answerCallbackQuery(callbackQuery.id, '✅ Premium berhasil diaktifkan!');
  } else {
    await answerCallbackQuery(callbackQuery.id, `❌ Gagal: ${result.message}`);
  }
}

// ─── ADMIN: TOLAK ORDER ──────────────────────────────────────────
async function handleAdminReject(callbackQuery, orderId) {
  const msgId = callbackQuery.message.message_id;
  const adminChatId = callbackQuery.message.chat.id;

  if (String(adminChatId) !== String(ADMIN_CHAT_ID)) {
    await answerCallbackQuery(callbackQuery.id, '⛔ Hanya admin yang bisa menolak.');
    return;
  }

  const order = await Order.findById(orderId);
  if (!order || order.status !== 'pending') {
    await answerCallbackQuery(callbackQuery.id, 'Order tidak ditemukan atau sudah diproses.');
    return;
  }

  order.status = 'rejected';
  await order.save();

  await editMessageText(adminChatId, msgId,
    `❌ *Order Ditolak*\n\nOrder ID: \`${orderId}\`\nGoogle ID: \`${order.googleId}\``
  );

  await sendMessage(order.telegramUserId,
    `❌ *Pembayaran Ditolak*\n\n` +
    `Maaf, pembayaran kamu tidak dapat diverifikasi.\n` +
    `Silakan hubungi admin atau ketik /beli untuk mencoba lagi.`
  );

  await answerCallbackQuery(callbackQuery.id, 'Order ditolak.');
}

// ─── AKTIVASI PREMIUM ────────────────────────────────────────────
async function aktivasiPremiumById(orderId) {
  try {
    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: 'Order tidak ditemukan.' };
    if (order.status !== 'pending') return { success: false, message: 'Order sudah diproses.' };
    if (!order.googleId) return { success: false, message: 'Google ID kosong.' };

    // Update user premium langsung di MongoDB
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + order.paketDurasi);

    const user = await User.findOne({ googleId: order.googleId });
    if (!user) return { success: false, message: `User dengan Google ID ${order.googleId} tidak ditemukan.` };

    user.isPremium = true;
    user.premiumUntil = expDate;

    if (!user.notifications) user.notifications = [];
    user.notifications.push({
      title: '🎉 Premium Diaktifkan!',
      message: `Admin telah mengaktifkan status Premium kamu selama ${order.paketDurasi} hari. Nikmati fitur unduhan tanpa batas!`,
      isRead: false,
      createdAt: new Date(),
    });

    await user.save();

    // Update status order
    order.status = 'confirmed';
    await order.save();

    return { success: true, order };
  } catch (err) {
    console.error('[TG] aktivasiPremium error:', err.message);
    return { success: false, message: err.message };
  }
}

// ─── HELPER ──────────────────────────────────────────────────────
function getExpDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ─── API untuk Flutter Admin ─────────────────────────────────────

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
  if (!result.success) return result;

  // Notif ke user Telegram
  try {
    await sendMessage(result.order.telegramUserId,
      `🎉 *Premium Aktif!*\n\n` +
      `Paket *${result.order.paketNama}* sudah diaktifkan!\n` +
      `Berlaku sampai: *${getExpDate(result.order.paketDurasi)}*\n\n` +
      `Selamat menikmati akses tanpa batas! 📚✨`
    );
  } catch (e) {
    console.error('[TG] Gagal notif user:', e.message);
  }

  return result;
}

async function rejectOrderFromApp(orderId) {
  try {
    const order = await Order.findById(orderId);
    if (!order || order.status !== 'pending') {
      return { success: false, message: 'Order tidak ditemukan atau sudah diproses.' };
    }

    order.status = 'rejected';
    await order.save();

    await sendMessage(order.telegramUserId,
      `❌ *Pembayaran Ditolak*\n\n` +
      `Maaf, pembayaran tidak dapat diverifikasi.\n` +
      `Ketik /beli untuk mencoba lagi atau hubungi admin.`
    );

    return { success: true, message: 'Order ditolak.' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ─── SETUP WEBHOOK (panggil sekali saat deploy) ──────────────────
async function setupWebhook(webhookUrl) {
  try {
    const res = await axios.post(`${BASE_URL}/setWebhook`, { url: webhookUrl });
    console.log('[TG] Webhook set:', res.data);
  } catch (err) {
    console.error('[TG] Gagal set webhook:', err.response?.data || err.message);
  }
}

module.exports = {
  handleUpdate,
  setupWebhook,
  getPendingOrders,
  confirmOrderFromApp,
  rejectOrderFromApp,
};
