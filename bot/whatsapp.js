/**
 * =============================================
 *  WhatsApp Bot - Doujin Desu Premium
 *  Terintegrasi dengan backend Express + MongoDB
 * =============================================
 * 
 *  Fitur:
 *  - Kirim QRIS otomatis ke pembeli
 *  - Notifikasi ke admin saat bukti bayar dikirim
 *  - Admin konfirmasi via WA → premium langsung aktif di DB
 *  - Notifikasi push ke user (lewat endpoint /notifications)
 * =============================================
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

// ─── KONFIGURASI ─────────────────────────────────────────────────────────────

const BOT_CONFIG = {
  // Nomor WA Admin (format internasional tanpa +, tambah @c.us)
  // Diambil dari database Settings secara dinamis, ini hanya fallback
  ADMIN_NUMBER_FALLBACK: process.env.ADMIN_WA_NUMBER
    ? `${process.env.ADMIN_WA_NUMBER}@c.us`
    : '628xxxxxxxxxx@c.us',

  // Path file QRIS (letakkan qris.png di folder public/)
  QRIS_IMAGE_PATH: path.join(__dirname, '..', 'public', 'qris.png'),

  // Batas waktu menunggu bukti bayar dari user (menit)
  PAYMENT_TIMEOUT_MINUTES: 30,

  PAKET: {
    '1': { nama: 'Paket 7 Hari',  harga: 'Rp 5.000',  durasi: 7,  label: '7hari' },
    '2': { nama: 'Paket 30 Hari', harga: 'Rp 15.000', durasi: 30, label: '30hari' },
  },
};

// ─── STATE USER (In-memory) ───────────────────────────────────────────────────
// Format: { [nomorWA]: { step, paket, googleId, timestamp } }
const userState = {};

// ─── PENDING ORDERS (menunggu konfirmasi admin) ───────────────────────────────
// Format: { [orderKey]: { from, paket, googleId, timestamp } }
const pendingOrders = {};

// ─── INISIALISASI CLIENT ─────────────────────────────────────────────────────
let botClient = null;

function createClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  });

  client.on('qr', (qr) => {
    console.log('\n📱 Scan QR ini untuk login WhatsApp Bot:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('✅ [WhatsApp Bot] Siap digunakan!');
  });

  client.on('disconnected', (reason) => {
    console.warn('⚠️  [WhatsApp Bot] Terputus:', reason);
    // Auto-reconnect setelah 5 detik
    setTimeout(() => {
      console.log('🔄 [WhatsApp Bot] Mencoba reconnect...');
      client.initialize();
    }, 5000);
  });

  client.on('message', handleIncomingMessage);

  return client;
}

// ─── HANDLER PESAN MASUK ─────────────────────────────────────────────────────
async function handleIncomingMessage(msg) {
  if (msg.isGroupMsg) return;

  const from    = msg.from;
  const body    = msg.body.trim();
  const bodyLow = body.toLowerCase();
  const state   = userState[from] || { step: 'idle' };

  try {
    // ── ADMIN COMMAND ──────────────────────────────────────────────────────────
    const adminNumber = await getAdminNumber();
    if (from === adminNumber) {
      await handleAdminMessage(msg, body, bodyLow);
      return;
    }

    // ── USER FLOW ─────────────────────────────────────────────────────────────

    // Step: IDLE — tunggu trigger
    if (state.step === 'idle') {
      const triggers = ['halo', 'hai', 'hi', 'hello', 'beli', 'premium', 'mulai', 'start', 'order'];
      if (triggers.some(k => bodyLow.includes(k))) {
        userState[from] = { step: 'ask_googleid' };
        await msg.reply(
          `👋 Selamat datang di *Doujin Desu Premium*!\n\n` +
          `Untuk memulai, kirimkan *Google ID* akun kamu.\n\n` +
          `📌 Cara cek Google ID:\n` +
          `Buka aplikasi → Profil → salin ID yang tertera di bawah email kamu.`
        );
      } else {
        await msg.reply(`Ketik *halo* atau *beli* untuk memulai pembelian Premium 🎉`);
      }
      return;
    }

    // Step: MINTA GOOGLE ID
    if (state.step === 'ask_googleid') {
      // Google ID biasanya berupa string alfanumerik 28 karakter
      if (body.length < 10) {
        await msg.reply(`⚠️ Google ID tidak valid. Coba lagi — salin tepat dari aplikasi.`);
        return;
      }
      userState[from] = { step: 'pilih_paket', googleId: body };
      await msg.reply(menuPaket());
      return;
    }

    // Step: PILIH PAKET
    if (state.step === 'pilih_paket') {
      if (BOT_CONFIG.PAKET[body]) {
        const paket = BOT_CONFIG.PAKET[body];
        userState[from] = { ...state, step: 'konfirmasi', paket };
        await msg.reply(
          `✅ Kamu memilih *${paket.nama}* seharga *${paket.harga}*\n\n` +
          `Lanjutkan pembayaran?\nKetik *ya* atau *tidak*.`
        );
      } else {
        await msg.reply(`⚠️ Pilih angka *1* atau *2*.\n\n` + menuPaket());
      }
      return;
    }

    // Step: KONFIRMASI
    if (state.step === 'konfirmasi') {
      if (bodyLow === 'ya') {
        const paket = state.paket;
        userState[from] = { ...state, step: 'menunggu_bayar', timestamp: Date.now() };

        await msg.reply(
          `💳 *Detail Pembayaran*\n\n` +
          `📦 Paket  : ${paket.nama}\n` +
          `💰 Harga  : *${paket.harga}*\n` +
          `⏳ Durasi : ${paket.durasi} hari\n\n` +
          `Scan QR QRIS berikut untuk membayar.\n` +
          `Setelah transfer, kirim *foto/screenshot bukti bayar* ke sini.\n\n` +
          `_Aktivasi 1–5 menit setelah admin konfirmasi._`
        );

        await kirimQRIS(from);

      } else if (bodyLow === 'tidak' || bodyLow === 'batal') {
        userState[from] = { step: 'idle' };
        await msg.reply(`❌ Dibatalkan. Ketik *halo* untuk mulai lagi.`);
      } else {
        await msg.reply(`Balas *ya* untuk lanjut atau *tidak* untuk batal.`);
      }
      return;
    }

    // Step: MENUNGGU BUKTI BAYAR
    if (state.step === 'menunggu_bayar') {
      // Cek timeout (30 menit)
      if (Date.now() - (state.timestamp || 0) > BOT_CONFIG.PAYMENT_TIMEOUT_MINUTES * 60 * 1000) {
        userState[from] = { step: 'idle' };
        await msg.reply(
          `⏰ Sesi pembelian kamu sudah habis (${BOT_CONFIG.PAYMENT_TIMEOUT_MINUTES} menit).\n` +
          `Ketik *halo* untuk memulai lagi.`
        );
        return;
      }

      // Terima bukti bayar (gambar ATAU teks konfirmasi)
      if (msg.hasMedia || bodyLow.includes('bukti') || bodyLow.includes('sudah') || bodyLow.includes('bayar') || bodyLow.includes('transfer')) {
        const orderKey = `${from}_${Date.now()}`;
        const paket = state.paket;

        // Simpan ke pending orders
        pendingOrders[orderKey] = {
          from,
          paket,
          googleId: state.googleId,
          timestamp: Date.now(),
          nomorUser: from.replace('@c.us', ''),
        };

        // Notifikasi admin
        await notifikasiAdmin(orderKey, pendingOrders[orderKey], msg);

        userState[from] = { step: 'idle' };
        await msg.reply(
          `✅ *Bukti bayar diterima!*\n\n` +
          `Pesananmu sedang diverifikasi admin.\n` +
          `Premium akan aktif dalam *1–5 menit* ⚡\n\n` +
          `Terima kasih sudah berlangganan *Doujin Desu Premium* 🎉`
        );

      } else {
        await msg.reply(
          `⏳ Silakan selesaikan pembayaran via QRIS lalu kirim *foto bukti transfer* ke sini.`
        );
      }
      return;
    }

    // Default
    await msg.reply(`Ketik *halo* untuk memulai pembelian Premium.`);

  } catch (err) {
    console.error('[Bot Error]', err.message);
  }
}

// ─── HANDLER PESAN ADMIN ─────────────────────────────────────────────────────
async function handleAdminMessage(msg, body, bodyLow) {
  // Command: KONFIRMASI <orderKey> <googleId> <days>
  // Contoh:  KONFIRMASI abc123_1700000 GoogleID123 30
  if (bodyLow.startsWith('konfirmasi')) {
    const parts = body.split(' ');
    if (parts.length < 4) {
      await msg.reply(
        `⚠️ Format salah!\n\n` +
        `Gunakan: *KONFIRMASI <orderKey> <googleId> <days>*\n` +
        `Contoh: KONFIRMASI abc_123 GoogleUID 30`
      );
      return;
    }

    const [, orderKey, googleId, daysStr] = parts;
    const days = parseInt(daysStr);

    if (isNaN(days) || days <= 0) {
      await msg.reply(`⚠️ Jumlah hari tidak valid.`);
      return;
    }

    // Aktivasi premium via API internal
    const success = await aktivasiPremium(googleId, days);

    if (success) {
      const order = pendingOrders[orderKey];

      // Beritahu user
      if (order) {
        try {
          await botClient.sendMessage(
            order.from,
            `🎉 *Premium Aktif!*\n\n` +
            `Paket *${order.paket.nama}* kamu sudah diaktifkan!\n` +
            `Berlaku hingga: *${getExpDate(days)}*\n\n` +
            `Selamat menikmati akses tanpa batas! 📚✨`
          );
        } catch (e) {
          console.error('[Bot] Gagal kirim notif ke user:', e.message);
        }
        delete pendingOrders[orderKey];
      }

      await msg.reply(`✅ Premium berhasil diaktifkan untuk *${googleId}* selama *${days} hari*.`);
    } else {
      await msg.reply(`❌ Gagal aktivasi premium. Cek Google ID atau koneksi server.`);
    }
    return;
  }

  // Command: LIST (lihat pending orders)
  if (bodyLow === 'list' || bodyLow === 'pesanan') {
    const keys = Object.keys(pendingOrders);
    if (keys.length === 0) {
      await msg.reply(`📭 Tidak ada pesanan pending.`);
      return;
    }
    const listText = keys.map((k, i) => {
      const o = pendingOrders[k];
      const waktu = new Date(o.timestamp).toLocaleString('id-ID');
      return `${i + 1}. *${o.paket.nama}*\n   📱 +${o.nomorUser}\n   🆔 ${o.googleId}\n   🕐 ${waktu}\n   🔑 Key: ${k}`;
    }).join('\n\n');

    await msg.reply(`📋 *Pesanan Pending (${keys.length})*\n\n${listText}\n\nGunakan:\n*KONFIRMASI <key> <googleId> <days>*`);
    return;
  }

  // Command: HELP admin
  if (bodyLow === 'help' || bodyLow === 'bantuan') {
    await msg.reply(
      `🤖 *Admin Commands*\n\n` +
      `📋 *pesanan* — Lihat semua pesanan pending\n` +
      `✅ *KONFIRMASI <key> <googleId> <days>* — Aktifkan premium\n\n` +
      `Contoh:\nKONFIRMASI abc_123 UID123 30`
    );
  }
}

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────

function menuPaket() {
  return (
    `🌟 *Pilih Paket Premium*\n\n` +
    `1️⃣  *Paket 7 Hari*  — Rp 5.000\n` +
    `2️⃣  *Paket 30 Hari* — Rp 15.000 ~~Rp 20.000~~ ⭐ PALING LARIS\n\n` +
    `Balas dengan angka *1* atau *2*.`
  );
}

function getExpDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function kirimQRIS(to) {
  try {
    if (!fs.existsSync(BOT_CONFIG.QRIS_IMAGE_PATH)) {
      await botClient.sendMessage(to, `⚠️ QRIS belum tersedia. Hubungi admin langsung.`);
      return;
    }
    const media = MessageMedia.fromFilePath(BOT_CONFIG.QRIS_IMAGE_PATH);
    await botClient.sendMessage(to, media, {
      caption: `📲 *Scan QR ini via QRIS*\n_Mendukung semua e-wallet & mobile banking._`,
    });
  } catch (err) {
    console.error('[Bot] Gagal kirim QRIS:', err.message);
  }
}

async function notifikasiAdmin(orderKey, order, msg) {
  try {
    const adminNumber = await getAdminNumber();
    const teks =
      `🔔 *Pesanan Baru!*\n\n` +
      `📦 Paket  : ${order.paket.nama} (${order.paket.harga})\n` +
      `📱 WA     : +${order.nomorUser}\n` +
      `🆔 Google : ${order.googleId}\n` +
      `🕐 Waktu  : ${new Date().toLocaleString('id-ID')}\n\n` +
      `*Untuk konfirmasi:*\n` +
      `KONFIRMASI ${orderKey} ${order.googleId} ${order.paket.durasi}`;

    await botClient.sendMessage(adminNumber, teks);

    // Forward bukti bayar jika ada gambar
    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      await botClient.sendMessage(adminNumber, media, {
        caption: `📎 Bukti bayar dari +${order.nomorUser}`,
      });
    }
  } catch (err) {
    console.error('[Bot] Gagal notifikasi admin:', err.message);
  }
}

// Aktivasi premium via HTTP ke endpoint internal
async function aktivasiPremium(googleId, days) {
  try {
    // Import axios (sudah ada di package.json)
    const axios = require('axios');
    const BASE_URL = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
    
    const res = await axios.post(`${BASE_URL}/api/users/${googleId}/set-premium`, {
      days,
      // Sertakan admin UID untuk bypass auth jika dibutuhkan
      adminId: (process.env.ADMIN_UIDS || '').split(',')[0],
    });

    return res.data.success === true;
  } catch (err) {
    console.error('[Bot] Gagal aktivasi premium:', err.response?.data || err.message);
    return false;
  }
}

// Ambil nomor admin dari database Settings (live)
async function getAdminNumber() {
  try {
    const axios = require('axios');
    const BASE_URL = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const res = await axios.get(`${BASE_URL}/api/settings/whatsapp`);
    if (res.data.success && res.data.whatsapp) {
      return `${res.data.whatsapp}@c.us`;
    }
  } catch (_) {}
  return BOT_CONFIG.ADMIN_NUMBER_FALLBACK;
}

// ─── INIT FUNCTION (dipanggil dari app.js) ──────────────────────────────────
function initWhatsAppBot() {
  if (process.env.DISABLE_WA_BOT === 'true') {
    console.log('ℹ️  [WhatsApp Bot] Dinonaktifkan via env DISABLE_WA_BOT=true');
    return;
  }

  console.log('🤖 [WhatsApp Bot] Memulai...');
  botClient = createClient();
  botClient.initialize();
}

// ─── API: Konfirmasi order dari Flutter Admin ─────────────────────────────
/**
 * Dipanggil dari routes/api.js untuk konfirmasi order
 * @returns {{ success: boolean, message: string }}
 */
async function confirmOrderFromApp(orderKey) {
  const order = pendingOrders[orderKey];
  if (!order) return { success: false, message: 'Order tidak ditemukan atau sudah dikonfirmasi.' };

  const success = await aktivasiPremium(order.googleId, order.paket.durasi);
  if (!success) return { success: false, message: 'Gagal aktivasi premium di database.' };

  // Notifikasi ke user via WA
  if (botClient) {
    try {
      await botClient.sendMessage(
        order.from,
        `🎉 *Premium Aktif!*\n\n` +
        `Paket *${order.paket.nama}* sudah diaktifkan!\n` +
        `Berlaku hingga: *${getExpDate(order.paket.durasi)}*\n\n` +
        `Selamat menikmati akses tanpa batas! 📚✨`
      );
    } catch (e) {
      console.error('[Bot] Gagal kirim notif ke user:', e.message);
    }
  }

  delete pendingOrders[orderKey];
  return { success: true, message: `Premium berhasil diaktifkan untuk ${order.googleId}` };
}

/**
 * Tolak / hapus order pending
 */
async function rejectOrderFromApp(orderKey) {
  const order = pendingOrders[orderKey];
  if (!order) return { success: false, message: 'Order tidak ditemukan.' };

  // Beritahu user
  if (botClient) {
    try {
      await botClient.sendMessage(
        order.from,
        `❌ *Pembayaran Ditolak*\n\n` +
        `Maaf, pembayaran kamu tidak dapat diverifikasi.\n` +
        `Silakan hubungi admin atau coba lagi.\n\n` +
        `Ketik *halo* untuk memulai ulang.`
      );
    } catch (e) {
      console.error('[Bot] Gagal kirim notif tolak:', e.message);
    }
  }

  delete pendingOrders[orderKey];
  return { success: true, message: 'Order berhasil ditolak.' };
}

/**
 * Ambil semua pending orders (untuk API admin)
 */
function getPendingOrders() {
  return Object.entries(pendingOrders).map(([key, order]) => ({
    orderKey: key,
    nomorWA: '+' + order.nomorUser,
    googleId: order.googleId,
    paketNama: order.paket.nama,
    paketHarga: order.paket.harga,
    paketDurasi: order.paket.durasi,
    timestamp: order.timestamp,
  }));
}

module.exports = { initWhatsAppBot, getPendingOrders, confirmOrderFromApp, rejectOrderFromApp };
