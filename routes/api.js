const express = require('express');
const router = express.Router();
const Manga = require('../models/Manga');
const Chapter = require('../models/Chapter');
const User = require('../models/User');
const mongoose = require('mongoose');

// ==========================================
// HELPER FUNCTIONS
// ==========================================

const successResponse = (res, data, pagination = null) => {
    res.json({ success: true, data, pagination });
};

const errorResponse = (res, message, code = 500) => {
    console.error(`[Error] ${message}`);
    res.status(code).json({ success: false, message });
};

const settingsSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: String
});
// Cek jika model sudah ada untuk menghindari OverwriteModelError
const Settings = mongoose.models.Settings || mongoose.model('Settings', settingsSchema);

// Helper: Pagination
const getPaginationParams = (req, defaultLimit = 24) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || defaultLimit);
    const skip = (page - 1) * limit;
    return { page, limit, skip };
};

// Helper: Attach Chapter Counts
async function attachChapterCounts(mangas) {
    if (!mangas || mangas.length === 0) return [];
    const mangaIds = mangas.map(m => m._id);
    const counts = await Chapter.aggregate([
        { $match: { manga_id: { $in: mangaIds } } },
        { $group: { _id: "$manga_id", count: { $sum: 1 } } }
    ]);
    const countMap = {};
    counts.forEach(c => { countMap[c._id.toString()] = c.count; });
    return mangas.map(m => ({ ...m, chapter_count: countMap[m._id.toString()] || 0 }));
}

// Middleware: Is Admin
// DIPERBAIKI: Cek Headers juga (karena GET request dari Flutter pakai header)
const isAdmin = async (req, res, next) => {
    const adminId = req.body.adminId || req.headers['adminid']; // Cek Body & Header
    const ADMIN_UIDS = ['TPuc7EiYeFZcea9HGMe0mwl2ie13']; // Pastikan UID ini BENAR

    if (!adminId || !ADMIN_UIDS.includes(adminId)) {
        return errorResponse(res, 'Akses ditolak. Hanya untuk Admin.', 403);
    }
    next();
};

// ==========================================
// 1. HOME & LISTING ENDPOINTS
// ==========================================

router.get('/home', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);
        const totalMangaPromise = Manga.countDocuments();

        const recentsPromise = Manga.find()
            .select('title slug thumb metadata createdAt updatedAt')
            .sort({ updatedAt: -1 })
            .skip(skip).limit(limit).lean();

        const trendingPromise = Manga.find()
            .select('title slug thumb views metadata')
            .sort({ views: -1 }).limit(10).lean();

        const manhwasPromise = Manga.find({ 'metadata.type': { $regex: 'manhwa', $options: 'i' } })
            .select('title slug thumb metadata updatedAt')
            .sort({ updatedAt: -1 }).limit(10).lean();

        const [totalManga, recentsRaw, trendingRaw, manhwasRaw] = await Promise.all([
            totalMangaPromise, recentsPromise, trendingPromise, manhwasPromise
        ]);

        const [recents, trending, manhwas] = await Promise.all([
            attachChapterCounts(recentsRaw),
            attachChapterCounts(trendingRaw),
            attachChapterCounts(manhwasRaw)
        ]);

        successResponse(res, { recents, trending, manhwas }, {
            currentPage: page,
            totalPages: Math.ceil(totalManga / limit),
            totalItems: totalManga,
            perPage: limit
        });
    } catch (err) { errorResponse(res, err.message); }
});

router.get('/manga-list', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);
        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(),
            Manga.find().select('title slug thumb metadata.rating metadata.status metadata.type')
                .sort({ title: 1 }).skip(skip).limit(limit).lean()
        ]);
        const mangas = await attachChapterCounts(mangasRaw);
        successResponse(res, mangas, {
            currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total, perPage: limit
        });
    } catch (err) { errorResponse(res, err.message); }
});

// ==========================================
// 2. DETAIL & READ ENDPOINTS
// ==========================================

router.get('/manga/:slug', async (req, res) => {
    try {
        const manga = await Manga.findOneAndUpdate(
            { slug: req.params.slug }, { $inc: { views: 1 } }, { new: true, timestamps: false }
        ).lean();
        if (!manga) return errorResponse(res, 'Manga not found', 404);

        const chapters = await Chapter.find({ manga_id: manga._id })
            .select('title slug chapter_index createdAt')
            .sort({ chapter_index: -1 })
            .collation({ locale: "en_US", numericOrdering: true }).lean();

        manga.chapter_count = chapters.length;
        successResponse(res, { info: manga, chapters });
    } catch (err) { errorResponse(res, err.message); }
});

router.get('/read/:slug/:chapterSlug', async (req, res) => {
    try {
        const manga = await Manga.findOne({ slug: req.params.slug }).select('_id title slug thumb').lean();
        if (!manga) return errorResponse(res, 'Manga not found', 404);

        const chapter = await Chapter.findOne({ manga_id: manga._id, slug: req.params.chapterSlug }).lean();
        if (!chapter) return errorResponse(res, 'Chapter not found', 404);

        const [nextChap, prevChap] = await Promise.all([
            Chapter.findOne({ manga_id: manga._id, chapter_index: { $gt: chapter.chapter_index } })
                .sort({ chapter_index: 1 }).select('slug title').collation({ locale: "en_US", numericOrdering: true }).lean(),
            Chapter.findOne({ manga_id: manga._id, chapter_index: { $lt: chapter.chapter_index } })
                .sort({ chapter_index: -1 }).select('slug title').collation({ locale: "en_US", numericOrdering: true }).lean()
        ]);
        successResponse(res, { chapter, manga, navigation: { next: nextChap ? nextChap.slug : null, prev: prevChap ? prevChap.slug : null } });
    } catch (err) { errorResponse(res, err.message); }
});

// ==========================================
// 3. SEARCH & FILTERS
// ==========================================

router.get('/search', async (req, res) => {
    try {
        const keyword = req.query.q;
        if (!keyword) return errorResponse(res, 'Query parameter "q" required', 400);
        const { page, limit, skip } = getPaginationParams(req);
        const query = { title: { $regex: keyword, $options: 'i' } };
        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(query),
            Manga.find(query).select('title slug thumb metadata').skip(skip).limit(limit).lean()
        ]);
        const mangas = await attachChapterCounts(mangasRaw);
        successResponse(res, mangas, { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total, perPage: limit });
    } catch (err) { errorResponse(res, err.message); }
});

router.get('/genres', async (req, res) => {
    try {
        const genres = await Manga.aggregate([
            { $unwind: "$tags" }, { $match: { tags: { $ne: "" } } },
            { $group: { _id: "$tags", count: { $sum: 1 } } }, { $sort: { _id: 1 } }
        ]);
        successResponse(res, genres.map(g => ({ name: g._id, count: g.count })));
    } catch (err) { errorResponse(res, err.message); }
});

router.get('/filter/:type/:value', async (req, res) => {
    try {
        const { type, value } = req.params;
        const { page, limit, skip } = getPaginationParams(req);
        let query = {};
        if (type === 'genre') {
            const cleanValue = value.replace(/-/g, '[\\s\\-]');
            query = { tags: { $regex: new RegExp(cleanValue, 'i') } };
        } else if (type === 'status') query = { 'metadata.status': { $regex: `^${value}$`, $options: 'i' } };
        else if (type === 'type') query = { 'metadata.type': { $regex: `^${value}$`, $options: 'i' } };
        else return errorResponse(res, 'Invalid filter', 400);

        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(query),
            Manga.find(query).sort({ updatedAt: -1 }).select('title slug thumb metadata updatedAt').skip(skip).limit(limit).lean()
        ]);
        const mangas = await attachChapterCounts(mangasRaw);
        successResponse(res, mangas, { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total, filter: { type, value }, perPage: limit });
    } catch (err) { errorResponse(res, err.message); }
});

// ==========================================
// 4. USER ENDPOINTS
// ==========================================

router.post('/users/sync', async (req, res) => {
    try {
        const { googleId, email, displayName } = req.body;
        if (!googleId) return errorResponse(res, 'googleId is required', 400);
        const ADMIN_UIDS = ['TPuc7EiYeFZcea9HGMe0mwl2ie13'];
        const isUserAdmin = ADMIN_UIDS.includes(googleId);
        let user = await User.findOne({ googleId });
        const today = new Date().toISOString().split('T')[0];

        if (!user) {
            user = new User({
                googleId, email, displayName, isAdmin: isUserAdmin, isPremium: isUserAdmin, dailyDownloads: { date: today, count: 0 }
            });
        } else {
            user.isAdmin = isUserAdmin;
            if (isUserAdmin) user.isPremium = true;
            else if (user.isPremium && user.premiumUntil) {
                if (new Date() > user.premiumUntil) { user.isPremium = false; user.premiumUntil = null; }
            }
            if (!user.dailyDownloads || user.dailyDownloads.date !== today) {
                user.dailyDownloads = { date: today, count: 0 };
            }
        }
        await user.save();
        successResponse(res, user);
    } catch (err) { errorResponse(res, err.message); }
});

router.post('/users/:googleId/library', async (req, res) => {
    try {
        const { googleId } = req.params; const { slug, mangaData } = req.body;
        const user = await User.findOne({ googleId });
        if (!user) return errorResponse(res, 'User not found', 404);
        const idx = user.library.findIndex(item => item.slug === slug);
        if (idx >= 0) { user.library[idx].mangaData = mangaData; user.library[idx].addedAt = Date.now(); }
        else user.library.push({ slug, mangaData });
        await user.save();
        successResponse(res, user.library);
    } catch (err) { errorResponse(res, err.message); }
});

router.post('/users/:googleId/history', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { type, slug, title, thumb, lastChapterTitle, lastChapterSlug } = req.body;
        const user = await User.findOne({ googleId });
        if (!user) return errorResponse(res, 'User not found', 404);
        const idx = user.history.findIndex(item => item.slug === slug);
        if (idx >= 0) {
            user.history[idx].lastChapterTitle = lastChapterTitle;
            user.history[idx].lastChapterSlug = lastChapterSlug;
            user.history[idx].lastRead = Date.now();
        } else {
            user.history.push({ type, slug, title, thumb, lastChapterTitle, lastChapterSlug });
        }
        await user.save();
        successResponse(res, user.history);
    } catch (err) { errorResponse(res, err.message); }
});

router.delete('/users/:googleId/library/:slug', async (req, res) => {
    try {
        const user = await User.findOne({ googleId: req.params.googleId });
        if (!user) return errorResponse(res, 'User not found', 404);
        user.library = user.library.filter(item => item.slug !== req.params.slug);
        await user.save();
        successResponse(res, { message: 'Deleted' });
    } catch (err) { errorResponse(res, err.message); }
});

router.delete('/users/:googleId/library', async (req, res) => {
    try {
        const user = await User.findOne({ googleId: req.params.googleId });
        if (!user) return errorResponse(res, 'User not found', 404);
        user.library = [];
        await user.save();
        successResponse(res, { message: 'Cleared' });
    } catch (err) { errorResponse(res, err.message); }
});

router.delete('/users/:googleId/history/:slug', async (req, res) => {
    try {
        const user = await User.findOne({ googleId: req.params.googleId });
        if (!user) return errorResponse(res, 'User not found', 404);
        user.history = user.history.filter(item => item.slug !== req.params.slug);
        await user.save();
        successResponse(res, { message: 'Deleted' });
    } catch (err) { errorResponse(res, err.message); }
});

router.delete('/users/:googleId/history', async (req, res) => {
    try {
        const user = await User.findOne({ googleId: req.params.googleId });
        if (!user) return errorResponse(res, 'User not found', 404);
        if (req.query.type) user.history = user.history.filter(item => item.type !== req.query.type);
        else user.history = [];
        await user.save();
        successResponse(res, { message: 'Cleared' });
    } catch (err) { errorResponse(res, err.message); }
});

router.post('/users/:googleId/download', async (req, res) => {
    try {
        const user = await User.findOne({ googleId: req.params.googleId });
        if (!user) return errorResponse(res, 'User not found', 404);
        if (!user.isAdmin && user.isPremium && user.premiumUntil && new Date() > user.premiumUntil) {
            user.isPremium = false; user.premiumUntil = null;
        }
        if (user.isPremium || user.isAdmin) {
            await user.save(); return successResponse(res, { allowed: true, isPremium: true });
        }
        const today = new Date().toISOString().split('T')[0];
        const MAX_LIMIT = 20;
        if (!user.dailyDownloads) user.dailyDownloads = { date: "", count: 0 };
        if (user.dailyDownloads.date !== today) { user.dailyDownloads.date = today; user.dailyDownloads.count = 0; }
        if (user.dailyDownloads.count >= MAX_LIMIT) {
            await user.save();
            return successResponse(res, { allowed: false, current: user.dailyDownloads.count, max: MAX_LIMIT, message: "Limit Harian Tercapai" });
        }
        user.dailyDownloads.count += 1; user.downloadCount += 1;
        await user.save();
        successResponse(res, { allowed: true, current: user.dailyDownloads.count, max: MAX_LIMIT });
    } catch (err) { errorResponse(res, err.message); }
});

// Route SET Premium Manual (Tanpa perlu middleware isAdmin di level express, validasi di dalam)
router.post('/users/:googleId/set-premium', async (req, res) => {
    try {
        // Cek Admin ID di Body
        const { adminId, days } = req.body;
        const ADMIN_UIDS = ['TPuc7EiYeFZcea9HGMe0mwl2ie13'];
        if (!adminId || !ADMIN_UIDS.includes(adminId)) return errorResponse(res, 'Forbidden', 403);

        const user = await User.findOne({ googleId: req.params.googleId });
        if (!user) return errorResponse(res, 'User not found', 404);

        user.isPremium = true;
        const expDate = new Date();
        expDate.setDate(expDate.getDate() + parseInt(days));
        user.premiumUntil = expDate;

        if (!user.notifications) user.notifications = [];
        user.notifications.push({
            title: "Premium Diaktifkan! 🎉",
            message: `Admin telah mengaktifkan status Premium kamu selama ${days} hari.`,
            isRead: false,
            createdAt: new Date()
        });
        await user.save();
        successResponse(res, { message: 'Premium Set', premiumUntil: user.premiumUntil });
    } catch (err) { errorResponse(res, err.message); }
});

router.get('/users/:googleId/notifications', async (req, res) => {
    try {
        const user = await User.findOne({ googleId: req.params.googleId }).select('notifications').lean();
        if (!user) return errorResponse(res, 'User not found', 404);
        const sorted = (user.notifications || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        successResponse(res, sorted);
    } catch (err) { errorResponse(res, err.message); }
});

router.put('/users/:googleId/notifications/read', async (req, res) => {
    try {
        await User.updateOne({ googleId: req.params.googleId }, { $set: { "notifications.$[].isRead": true } });
        successResponse(res, { message: 'Read all' });
    } catch (err) { errorResponse(res, err.message); }
});

// ==========================================
// 5. SETTINGS
// ==========================================

router.get('/settings/telegram', async (req, res) => {
    try {
        let setting = await Settings.findOne({ key: 'telegram_bot' });
        res.json({ success: true, telegram: setting ? setting.value : '' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/settings/telegram', async (req, res) => {
    try {
        const { telegram } = req.body;
        await Settings.findOneAndUpdate({ key: 'telegram_bot' }, { value: telegram }, { upsert: true });
        res.json({ success: true, telegram });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/telegram/status', async (req, res) => {
    try {
        const axios = require('axios');
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const webhookRes = await axios.get(`https://api.telegram.org/bot${token}/getWebhookInfo`);
        res.json({ success: true, webhook: webhookRes.data.result });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ==========================================
// 6. ADMIN & BOT INTEGRATION (Lazy Load)
// ==========================================

// Setup Webhook
router.post('/telegram/setup-webhook', isAdmin, async (req, res) => {
    try {
        const { setupWebhook } = require('../bot/telegram');
        const webhookUrl = `${process.env.SITE_URL}/api/telegram/webhook`;
        await setupWebhook(webhookUrl);
        successResponse(res, { message: `Webhook set: ${webhookUrl}` });
    } catch (err) { errorResponse(res, err.message); }
});

// Admin Broadcast
router.post('/admin/broadcast', isAdmin, async (req, res) => {
    try {
        const { title, message } = req.body;
        await User.updateMany({}, { $push: { notifications: { title, message, isRead: false, createdAt: new Date() } } });
        successResponse(res, { message: 'Broadcast Sent' });
    } catch (err) { errorResponse(res, err.message); }
});

// Admin Orders GET
router.get('/admin/orders', isAdmin, async (req, res) => {
    try {
        const { getPendingOrders } = require('../bot/telegram');
        const orders = await getPendingOrders();
        successResponse(res, orders);
    } catch (err) { errorResponse(res, err.message); }
});

// Admin Orders Confirm
router.post('/admin/orders/:orderKey/confirm', isAdmin, async (req, res) => {
    try {
        const { confirmOrderFromApp } = require('../bot/telegram');
        const result = await confirmOrderFromApp(req.params.orderKey);
        if (result.success) successResponse(res, { message: 'Confirmed' });
        else errorResponse(res, result.message, 400);
    } catch (err) { errorResponse(res, err.message); }
});

// Admin Orders Reject
router.delete('/admin/orders/:orderKey', isAdmin, async (req, res) => {
    try {
        const { rejectOrderFromApp } = require('../bot/telegram');
        const result = await rejectOrderFromApp(req.params.orderKey);
        if (result.success) successResponse(res, { message: result.message });
        else errorResponse(res, result.message, 400);
    } catch (err) { errorResponse(res, err.message); }
});

// ==========================================
// EXPORT ROUTER (HARUS PALING BAWAH)
// ==========================================
module.exports = router;