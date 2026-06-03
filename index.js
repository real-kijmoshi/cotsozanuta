require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const jwt = require('jsonwebtoken');
const helmet = require("helmet");
const compression = require("compression");
const { rateLimit } = require("express-rate-limit");
const genius = require("./utils/genius");
const db = require("./utils/db");

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Gzip/deflate all text responses (HTML, JSON, etc.)
app.use(compression());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],   // inline scripts in HTML pages
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      imgSrc:      ["'self'", "data:", "https:"],   // album art from any Genius CDN
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
    },
  },
}));
app.use(express.json({ limit: "16kb" }));

const loginLimiter        = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const statsLimiter        = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const leaderboardLimiter  = rateLimit({ windowMs: 60 * 1000, max: 3,  standardHeaders: true, legacyHeaders: false });
const lyricsLimiter       = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const rankedStartLimiter  = rateLimit({ windowMs: 60 * 1000, max: 5,  standardHeaders: true, legacyHeaders: false });
const rankedCorrectLimiter= rateLimit({ windowMs: 60 * 1000, max: 80, standardHeaders: true, legacyHeaders: false });
const rankedSongLimiter   = rateLimit({ windowMs: 60 * 1000, max: 80, standardHeaders: true, legacyHeaders: false });

// ── Ranked session store ─────────────────────────────────────
// Sessions expire after the game window + grace, cleaned up every 5 minutes.
const RANKED_DURATION_MS = 60_000;
const RANKED_GRACE_MS    =  3_000; // tiny grace for network latency
// Hard ceiling: 60s / ~3s minimum per song (see + answer) ≈ 20 songs realistically achievable.
// 30 gives a comfortable ceiling without being exploitable.
const MAX_RANKED_SONGS   = 30;
const rankedSessions     = new Map();

setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, s] of rankedSessions) {
        if (s.startedAt < cutoff) rankedSessions.delete(id);
    }
}, 5 * 60_000).unref();

const SKIP_PATTERNS = /\b(skit|interlude|acapella|remix|intro|outro|bonus|relacja|remaster)\b/i;

// otsochodziId stays null until warm-up completes; all game endpoints return 503 until then.
let otsochodziId = null;
let cachedAlbums  = null; // populated lazily on first /api/albums request; reset on server restart

(async () => {
  try {
    const artistId = await genius.getArtistIdByName("otsochodzi");
    if (!artistId) { console.error("[WARM] Could not resolve artist ID, game endpoints will be unavailable"); return; }

    // Fetch full song list — now includes album data for every song.
    const allSongs = await genius.getAllSongs(artistId);
    console.log(`[WARM] Song list loaded: ${allSongs.length} songs`);

    // Pre-warm daily songs (today + tomorrow) so the first player gets no cold delay.
    const today    = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    for (const entry of db.getDaily().filter(e => e.date === today || e.date === tomorrow)) {
      try {
        await genius.getWordArray(entry.songID);
        console.log(`[WARM] Pre-warmed lyrics for daily ${entry.date}`);
      } catch (e) {
        console.error(`[WARM] Failed for daily ${entry.date}:`, e.message);
      }
    }

    // Open traffic immediately after daily songs are ready.
    otsochodziId = artistId;
    console.log(`[WARM] Server ready — game endpoints open`);

    // Background: gradually warm the entire catalog (all uncached songs) so
    // every song becomes eligible over time without hammering the Genius API.
    const toWarm = allSongs.filter(s => !SKIP_PATTERNS.test(s.title) && !genius.getSongCacheEntry(s.id));
    const cachedCount = allSongs.length - toWarm.length;
    if (toWarm.length > 0) {
      console.log(`[WARM] Gradual background warm-up: ${toWarm.length} songs queued (${cachedCount} already cached)`);
      const CONCURRENCY = 3;
      const BATCH_DELAY = 1000; // ms between batches — gentle on the API
      const logEvery = Math.max(1, Math.floor(toWarm.length / 10)); // log ~every 10%
      (async () => {
        let done = 0;
        for (let i = 0; i < toWarm.length; i += CONCURRENCY) {
          await Promise.all(
            toWarm.slice(i, i + CONCURRENCY).map(s => genius.getSongById(s.id).catch(() => null))
          );
          done = Math.min(i + CONCURRENCY, toWarm.length);
          if (done % logEvery < CONCURRENCY || done === toWarm.length) {
            console.log(`[WARM] ${done}/${toWarm.length} songs warmed`);
          }
          if (i + CONCURRENCY < toWarm.length) await new Promise(r => setTimeout(r, BATCH_DELAY));
        }
        console.log(`[WARM] Background warm-up complete — all ${toWarm.length} songs cached`);
        cachedAlbums = null; // reset so /api/albums reflects newly warmed album data
      })();
    } else {
      console.log(`[WARM] All ${allSongs.length} songs already cached`);
    }
  } catch (e) {
    console.error("[WARM] Startup warm-up failed:", e.message);
  }
})();

// ── Song picker (shared by endless and ranked) ───────────────
// Returns { song, moreSongInfo } or null if no suitable song found.
// albumsParam: comma-separated album IDs/names for pool filtering (endless only)
// usedSongs:   Set of already-played songIds to exclude (ranked only)
async function pickSong(artistId, { albumsParam = '', usedSongs = null } = {}) {
    const allSongs = await genius.getAllSongs(artistId);
    if (!allSongs.length) return null;
    const filtered = allSongs.filter(s => !SKIP_PATTERNS.test(s.title));

    const isPrimary = (s) => s.artists.some(a => String(a.id) === String(artistId));
    const albumTracks = [], features = [], singles = [];
        for (const s of filtered) {
        const cached = genius.getSongCacheEntry(s.id);
        const album  = cached?.album ? cached.album : s.album;
        if (!isPrimary(s)) features.push(s);
        else if (album)    albumTracks.push(s);
        else               singles.push(s);
    }

    let customPool = null;
    if (albumsParam) {
        const albumIds = new Set(albumsParam.split(',').slice(0, 50).map(a => a.trim()).filter(Boolean));
        const albumFiltered = filtered.filter(s => {
            const cached = genius.getSongCacheEntry(s.id);
            const album  = cached?.album ? cached.album : s.album;
            return album && albumIds.has(String(album.id ?? album.name));
        });
        if (albumFiltered.length > 0) customPool = albumFiltered;
    }

    const exclude  = (pool) => usedSongs ? pool.filter(s => !usedSongs.has(s.id)) : pool;
    const pickPool = () => {
        if (customPool) return exclude(customPool);
        const ap = exclude(albumTracks), fp = exclude(features), sp = exclude(singles);
        const roll = Math.random();
        if (roll < 0.93 && ap.length) return ap;
        if (roll < 0.97 && fp.length) return fp;
        if (sp.length) return sp;
        return ap.length ? ap : exclude(filtered);
    };

    const seen = new Set();
    for (let i = 0; i < 15; i++) {
        const pool = pickPool();
        if (!pool.length) break;
        const candidate = pool[Math.floor(Math.random() * pool.length)];
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        const info = await genius.getSongById(candidate.id);
        if (info?.lyrics) return { song: candidate, moreSongInfo: info };
    }
    return null;
}

// Serve static files; images get a 7-day cache, ETag enables conditional GETs.
app.use("/images", express.static(path.join(__dirname, "public/images"), {
    maxAge: "7d",
    etag: true,
    lastModified: true,
}));
app.use(express.static(path.join(__dirname, "public"), { etag: true, lastModified: true }))

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/index.html"));
})

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/admin.html"));
})

app.get("/admin/stats", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/admin-stats.html"));
})

app.get("/regulamin", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/regulamin.html"));
})

app.get("/polityka-prywatnosci", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/polityka-prywatnosci.html"));
})
app.get("/discografia", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/discografia.html"))
})

app.get("/ranking", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/ranking.html"))
})
// ── Admin auth middleware ────────────────────────────────────
function timingSafeEqual(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
        // still run comparison to avoid length-based timing leak
        crypto.timingSafeEqual(ba, Buffer.alloc(ba.length));
        return false;
    }
    return crypto.timingSafeEqual(ba, bb);
}

function adminAuth(req, res, next) {
    const pwd = process.env.ADMIN_PASSWORD;
    if (!pwd) return res.status(500).json({ error: "ADMIN_PASSWORD not set" });
    // First try JWT Authorization header
    const authHeader = String(req.headers['authorization'] || '')
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        const token = authHeader.slice(7).trim()
        const secret = process.env.ADMIN_JWT_SECRET || pwd
        try {
            const payload = jwt.verify(token, secret)
            if (payload && payload.admin) return next()
        } catch (e) {
            // fallthrough to legacy check
        }
    }
    // Legacy: x-admin-password header (timing-safe)
    const auth = req.headers["x-admin-password"] || "";
    if (!timingSafeEqual(auth, pwd)) return res.status(401).json({ error: "Unauthorized" });
    next();
}

app.post("/api/admin/login", loginLimiter, (req, res) => {
    const pwd = process.env.ADMIN_PASSWORD;
    if (!pwd) return res.status(500).json({ error: "ADMIN_PASSWORD not set" });
    if (!timingSafeEqual(String(req.body.password || ""), pwd)) return res.status(401).json({ error: "Wrong password" });
    const secret = process.env.ADMIN_JWT_SECRET || pwd
    const token = jwt.sign({ admin: true }, secret, { expiresIn: process.env.ADMIN_JWT_EXPIRES || '12h' })
    res.json({ ok: true, token })
})

app.get("/api/admin/songs", adminAuth, async (req, res) => {
    try {
        const songs = await genius.getAllSongs(otsochodziId);
        res.json(songs.map(s => ({ id: s.id, title: s.title, cover: s.cover || null, artists: s.artists || [] })));
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch songs" });
    }
})

app.get("/api/admin/lyrics/:songId", adminAuth, async (req, res) => {
    const songIdInt = parseInt(req.params.songId, 10);
    if (!Number.isInteger(songIdInt) || songIdInt <= 0) {
        return res.status(400).json({ error: "Invalid songId" });
    }
    if (!otsochodziId || !genius.isArtistSong(otsochodziId, songIdInt)) {
        return res.status(404).json({ error: "Song not in Otsochodzi catalog" });
    }
    try {
        const info = await genius.getSongById(songIdInt);
        if (!info?.lyrics) return res.status(404).json({ error: "No lyrics found" });
        res.json({ lyrics: info.lyrics, title: info.title, cover: info.cover || null, wordCount: info.lyrics.split(/\s+/).filter(Boolean).length });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch lyrics" });
    }
})

app.get("/api/admin/daily", adminAuth, (req, res) => {
    try {
        res.json(db.getDaily());
    } catch (e) {
        res.status(500).json({ error: "Failed to read daily" });
    }
})

app.post("/api/admin/daily", adminAuth, (req, res) => {
    const { date, songID, wordIndex } = req.body;
    if (!date || !songID || typeof wordIndex !== "number") return res.status(400).json({ error: "Missing fields" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date format" });
    if (wordIndex < 0 || !Number.isInteger(wordIndex)) return res.status(400).json({ error: "Invalid wordIndex" });
    try {
        db.upsertDaily({ date, songID, wordIndex });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to write daily" });
    }
})

app.delete("/api/admin/daily/:date", adminAuth, (req, res) => {
    try {
        db.deleteDaily(req.params.date);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to write daily" });
    }
})

function calcMedian(arr) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2 * 10) / 10;
}

app.get("/api/admin/stats-overview", adminAuth, (req, res) => {
    try {
        const raw = db.getAllStats();  // { "YYYY-MM-DD": { correct: [], giveup: [] } }
        const dates = Object.keys(raw).sort();
        
        const perDay = dates.map(d => {
            const day = raw[d];
            const correct = day.correct.length;
            const giveup  = day.giveup.length;
            const plays   = correct + giveup;
            const avgWords = plays ? Math.round([...day.correct, ...day.giveup].reduce((a, b) => a + b, 0) / plays * 10) / 10 : 0;
            return { date: d, plays, correct, giveup, avgWords };
        });

        // monthly active users (unique days played per month treated as proxy)
        const byMonth = {};
        for (const d of perDay) {
            const m = d.date.slice(0, 7);
            if (!byMonth[m]) byMonth[m] = { month: m, plays: 0, correct: 0, giveup: 0, days: 0 };
            byMonth[m].plays   += d.plays;
            byMonth[m].correct += d.correct;
            byMonth[m].giveup  += d.giveup;
            byMonth[m].days    += 1;
        }

        const totals = perDay.reduce((acc, d) => {
            acc.plays   += d.plays;
            acc.correct += d.correct;
            acc.giveup  += d.giveup;
            return acc;
        }, { plays: 0, correct: 0, giveup: 0 });

        // ── Streaks ──────────────────────────────────────────────
        const todayStr = new Date().toISOString().split('T')[0];
        const dateSet  = new Set(dates);
        let currentStreak = 0;
        { const d = new Date(todayStr); while (dateSet.has(d.toISOString().split('T')[0])) { currentStreak++; d.setDate(d.getDate() - 1); } }
        let bestStreak = 0, runStreak = 0;
        for (let i = 0; i < dates.length; i++) {
            if (i === 0) { runStreak = 1; }
            else { runStreak = (new Date(dates[i]) - new Date(dates[i - 1])) / 86400000 === 1 ? runStreak + 1 : 1; }
            if (runStreak > bestStreak) bestStreak = runStreak;
        }

        // ── Peak day ─────────────────────────────────────────────
        const peakDay = perDay.length ? perDay.reduce((best, d) => d.plays > best.plays ? d : best) : null;

        // ── Week & month trends ───────────────────────────────────
        const nowMs = Date.now();
        const thisWeekPlays = perDay.filter(d => (nowMs - new Date(d.date).getTime()) / 86400000 < 7).reduce((s, d) => s + d.plays, 0);
        const lastWeekPlays = perDay.filter(d => { const age = (nowMs - new Date(d.date).getTime()) / 86400000; return age >= 7 && age < 14; }).reduce((s, d) => s + d.plays, 0);
        const weekTrend = lastWeekPlays ? Math.round((thisWeekPlays - lastWeekPlays) / lastWeekPlays * 100) : null;
        const prevMonthDate = new Date(todayStr); prevMonthDate.setDate(1); prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
        const thisMonth = todayStr.slice(0, 7), lastMonth = prevMonthDate.toISOString().slice(0, 7);
        const thisMonthPlays = perDay.filter(d => d.date.startsWith(thisMonth)).reduce((s, d) => s + d.plays, 0);
        const lastMonthPlays = perDay.filter(d => d.date.startsWith(lastMonth)).reduce((s, d) => s + d.plays, 0);
        const monthTrend = lastMonthPlays ? Math.round((thisMonthPlays - lastMonthPlays) / lastMonthPlays * 100) : null;

        // ── Avg words per outcome ─────────────────────────────────
        const allCorrectWords = Object.values(raw).flatMap(d => d.correct);
        const allGiveupWords  = Object.values(raw).flatMap(d => d.giveup);
        const avgWordsCorrect = allCorrectWords.length ? Math.round(allCorrectWords.reduce((a, b) => a + b, 0) / allCorrectWords.length * 10) / 10 : null;
        const avgWordsGiveup  = allGiveupWords.length  ? Math.round(allGiveupWords.reduce((a, b) => a + b, 0) / allGiveupWords.length  * 10) / 10 : null;

        // ── Median words per outcome ──────────────────────────────
        const medianWordsCorrect = calcMedian(allCorrectWords);
        const medianWordsGiveup  = calcMedian(allGiveupWords);

        // ── Word count distribution (buckets of 3 words) ─────────
        const allWords = [...allCorrectWords, ...allGiveupWords];
        const distMax  = allWords.length ? Math.max(...allWords) : 0;
        const BUCKET   = 3;
        const wordDistribution = [];
        for (let i = 1; i <= Math.min(distMax + BUCKET, 33); i += BUCKET) {
            const lo = i, hi = i + BUCKET - 1;
            wordDistribution.push({
                label:   `${lo}–${hi}`,
                correct: allCorrectWords.filter(w => w >= lo && w <= hi).length,
                giveup:  allGiveupWords.filter(w => w >= lo && w <= hi).length,
            });
        }
        const peakBucket = wordDistribution.length
            ? wordDistribution.reduce((best, b) => (b.correct + b.giveup) > (best.correct + best.giveup) ? b : best)
            : null;

        // ── Game Plays detailed breakdown (Daily, Endless, Ranked) ──
        const gamePlaysRaw = db.getGamePlays(); // [{ mode, date, count }]
        const playsByDate = {}; // { "YYYY-MM-DD": { endless: 0, ranked: 0, daily: 0 } }

        // Populate endless and ranked from game_plays
        for (const row of gamePlaysRaw) {
            if (!playsByDate[row.date]) {
                playsByDate[row.date] = { endless: 0, ranked: 0, daily: 0 };
            }
            if (row.mode === "endless") playsByDate[row.date].endless += row.count;
            if (row.mode === "ranked") playsByDate[row.date].ranked += row.count;
        }

        // Populate daily completions from daily_stats (for backward compatibility and total accuracy)
        for (const d of perDay) {
            if (!playsByDate[d.date]) {
                playsByDate[d.date] = { endless: 0, ranked: 0, daily: 0 };
            }
            playsByDate[d.date].daily += d.plays; // daily plays = correct + giveup in daily_stats
        }

        // Build a sorted array of all unique dates and their breakdown
        const allStatsDates = Array.from(new Set([
            ...Object.keys(playsByDate),
            ...dates
        ])).sort();

        const gamePlaysBreakdown = allStatsDates.map(d => {
            const p = playsByDate[d] || { endless: 0, ranked: 0, daily: 0 };
            return {
                date: d,
                daily: p.daily,
                endless: p.endless,
                ranked: p.ranked,
                total: p.daily + p.endless + p.ranked
            };
        });

        const totalEndless = gamePlaysBreakdown.reduce((s, g) => s + g.endless, 0);
        const totalRanked = gamePlaysBreakdown.reduce((s, g) => s + g.ranked, 0);
        const totalDaily = gamePlaysBreakdown.reduce((s, g) => s + g.daily, 0);
        const totalPlaysAll = totalEndless + totalRanked + totalDaily;

        // ── Avg & median games per unique user ────────────────────
        const uniqueUsers = db.getUniqueUserCount().total || 0;
        const avgGamesPerUser = uniqueUsers ? Math.round(totalPlaysAll / uniqueUsers * 10) / 10 : null;
        const gamesPerUserRows = db.getGamesPerUser(); // already sorted ASC by games
        const gamesPerUserCounts = gamesPerUserRows.map(r => r.games);
        const medianGamesPerUser = calcMedian(gamesPerUserCounts);

        const monthlyGamePlays = {}; // { "YYYY-MM": { daily: 0, endless: 0, ranked: 0 } }
        for (const g of gamePlaysBreakdown) {
            const m = g.date.slice(0, 7);
            if (!monthlyGamePlays[m]) {
                monthlyGamePlays[m] = { month: m, daily: 0, endless: 0, ranked: 0, total: 0 };
            }
            monthlyGamePlays[m].daily += g.daily;
            monthlyGamePlays[m].endless += g.endless;
            monthlyGamePlays[m].ranked += g.ranked;
            monthlyGamePlays[m].total += g.total;
        }
        const monthlyGamePlaysList = Object.values(monthlyGamePlays).sort((a,b) => a.month.localeCompare(b.month));

        res.json({
            dates, perDay, totals,
            byMonth: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
            streak:   { current: currentStreak, best: bestStreak },
            peakDay,
            trends:   { week: weekTrend, month: monthTrend, thisWeekPlays, lastWeekPlays, thisMonthPlays, lastMonthPlays },
            avgWords: { correct: avgWordsCorrect, giveup: avgWordsGiveup },
            medianWords: { correct: medianWordsCorrect, giveup: medianWordsGiveup },
            wordDistribution, peakBucket,
            avgGamesPerUser, medianGamesPerUser,
            gamePlays: {
                breakdown: gamePlaysBreakdown,
                totals: {
                    daily: totalDaily,
                    endless: totalEndless,
                    ranked: totalRanked,
                    all: totalPlaysAll
                },
                monthly: monthlyGamePlaysList
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to build stats overview" });
    }
})

app.get("/api/admin/ranked-overview", adminAuth, (req, res) => {
    try {
        const stats    = db.getRankedStats();
        const byMonth  = db.getRankedByMonth().map(r => ({
            month:       r.month,
            submissions: r.submissions,
            avgScore:    Math.round((r.avgScore || 0) * 10) / 10,
            topScore:    r.topScore || 0,
        }));
        const topScores = db.getLeaderboard(10);
        res.json({
            total:    stats.total    || 0,
            avgScore: stats.avgScore ? Math.round(stats.avgScore * 10) / 10 : 0,
            topScore: stats.topScore || 0,
            byMonth,
            topScores,
        });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch ranked overview" });
    }
})

app.get("/api/admin/users-overview", adminAuth, (req, res) => {
    try {
        const todayStr = new Date().toISOString().split("T")[0];
        const weekAgo  = new Date(Date.now() - 7  * 86400000).toISOString().split("T")[0];
        const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];

        const totalUnique = db.getUniqueUserCount().total || 0;
        const newByMonth  = db.getNewUsersByMonth();
        const dauByDate   = db.getDauByDate();

        // New users this week / this month (first appearance within window)
        const newThisWeek  = newByMonth.reduce((s, r) => {
            // can't filter by week from monthly buckets, use DAU approach instead
            return s;
        }, 0);
        // Compute new-user counts from raw first-seen data using a direct query proxy:
        // We count entries in newByMonth whose month >= weekAgo month and <= today
        // For exact week-level: use a threshold on dauByDate dates
        const newUsersThisWeek  = newByMonth
            .filter(r => r.month >= weekAgo.slice(0, 7))
            .reduce((s, r) => s + r.new_users, 0);
        const newUsersThisMonth = newByMonth
            .filter(r => r.month === todayStr.slice(0, 7))
            .reduce((s, r) => s + r.new_users, 0);

        // DAU today and last 7-day average
        const dauToday = (dauByDate.find(r => r.date === todayStr) || { dau: 0 }).dau;
        const last7Dau = dauByDate.filter(r => r.date >= weekAgo).map(r => r.dau);
        const avgDauWeek = last7Dau.length ? Math.round(last7Dau.reduce((a, b) => a + b, 0) / last7Dau.length) : 0;

        res.json({
            totalUnique,
            newUsersThisWeek,
            newUsersThisMonth,
            dauToday,
            avgDauWeek,
            newByMonth,   // [{ month, new_users }]
            dauByDate,    // [{ date, dau }]
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to build users overview" });
    }
})


app.get("/api/game/endless", rankedSongLimiter, async (req, res) => {
    if (!otsochodziId) return res.status(503).json({ error: "Server is initializing, try again shortly" });

    const { sessionId } = req.query;
    const rankedSession = sessionId ? rankedSessions.get(String(sessionId)) : null;

    try {
        const albumsParam = !rankedSession ? String(req.query.albums || '').trim() : '';
        const picked = await pickSong(otsochodziId, {
            albumsParam,
            usedSongs: rankedSession ? rankedSession.usedSongs : null,
        });
        if (!picked) return res.status(500).json({ error: "Could not find a song with lyrics" });
        const { song, moreSongInfo } = picked;

        const words = await genius.getWordArray(song.id);
        const response = {
            songId:    song.id,
            title:     song.title,
            wordCount: words.length,
            words,
            cover:     moreSongInfo.cover || song.cover || null,
            artists:   moreSongInfo.artists || song.artists || [],
            featured:  moreSongInfo.featured || [],
        };
        // Hints are not sent in ranked mode — enforced server-side.
        if (!rankedSession) {
            response.hints = { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate };
            // Log endless game play
            const endlessUid = req.headers['x-user-id'] ? String(req.headers['x-user-id']).trim().slice(0, 128) : null;
            db.logGamePlay("endless", endlessUid);
        } else {
            rankedSession.pendingId = song.id;
        }
        res.json(response);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch song" });
    }
});

app.get("/api/game/daily/:date", async (req, res) => {
    const { date } = req.params;
    try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: "Invalid date format" });
        }
        if (date > new Date().toISOString().split("T")[0]) {
            return res.status(400).json({ error: "Date cannot be in the future" });
        }
        
        const dailyData = db.getDailyByDate(date);
        if (!dailyData) {
            return res.status(404).json({ error: "No game found for this date" });
        }

        const { songID, wordIndex } = dailyData;
        const moreSongInfo = await genius.getSongById(songID);
        const words = moreSongInfo?.lyrics ? moreSongInfo.lyrics.split(/\s+/).filter(Boolean) : null;
        // Daily games are immutable — same date always returns same data.
        res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
        res.json({
            songId: songID,
            title: moreSongInfo.title,
            cover: moreSongInfo.cover || null,
            artists: moreSongInfo.artists || [],
            featured: moreSongInfo.featured || [],
            hints: { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate },
            wordIndex,
            words
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch daily game data" });
    }
});

app.get("/api/lyrics", lyricsLimiter, async (req, res) => {
    const { songId, wordIndex } = req.query;
    if (!songId || !wordIndex) {
        return res.status(400).json({ error: "Missing songId or wordIndex" });
    }
    const songIdInt = parseInt(songId, 10);
    if (!Number.isInteger(songIdInt) || songIdInt <= 0) {
        return res.status(400).json({ error: "Invalid songId" });
    }
    if (!otsochodziId || !genius.isArtistSong(otsochodziId, songIdInt)) {
        return res.status(404).json({ error: "Song not in Otsochodzi catalog" });
    }

    try {
        const words = await genius.getWordArray(songIdInt);
        if (!words) return res.status(404).json({ error: "Lyrics not available" });
        const idx = parseInt(wordIndex, 10);
        if (!Number.isInteger(idx) || idx < 0 || idx >= words.length) {
            return res.status(400).json({ error: "Invalid wordIndex" });
        }
        // A specific (songId, wordIndex) pair never changes — safe to cache long-term.
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.json({ word: words[idx] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch lyrics" });
    }
});

app.get("/api/autocomplete/songs", async (req, res) => {
    const { query } = req.query;
    if (!query || query.trim().length < 2) {
        return res.status(400).json({ error: "Query must be at least 2 characters" });
    }

    try {
        // Song list changes only when the cache is refreshed (startup/daily warm).
        // A 60-second private cache avoids redundant processing for rapid keystrokes
        // while still reflecting any song-cache updates within a minute.
        res.setHeader("Cache-Control", "private, max-age=60");
        const songs = await genius.searchCachedSongsByName(query.trim());
        res.json(songs.map(song => ({ id: song.id, title: song.title, cover: song.cover||null, artists: song.artists||[] })));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch autocomplete suggestions" });
    }
});

app.get("/api/discography", async (req, res) => {
    if (!otsochodziId) return res.status(503).json({ error: "Server is initializing" });
    try {
        const allSongs = await genius.getAllSongs(otsochodziId);
        const dailyCounts = db.getSongDailyCounts();
        const albumMap = new Map();
        const singles = [];

        // Build album map from allSongs
        for (const s of allSongs) {
            const cached = genius.getSongCacheEntry(s.id);
            const album  = cached?.album ? cached.album : s.album;
            const cover  = cached?.cover  || s.cover  || null;
            const artists = cached?.artists || s.artists || [];
            const songEntry = { id: s.id, title: s.title, cover, artists, dailyCount: dailyCounts[s.id] || 0 };

            if (album?.name) {
                const key = String(album.id ?? album.name);
                if (!albumMap.has(key)) {
                    albumMap.set(key, { albumId: key, albumName: album.name, albumCover: null, albumCoverPrimary: false, songs: [] });
                }
                const entry = albumMap.get(key);
                const isPrimaryOnTrack = artists.some(a => String(a.id) === String(otsochodziId));
                if (cover) {
                    if (isPrimaryOnTrack) {
                        // prefer covers from tracks where otsochodzi is present
                        entry.albumCover = cover;
                        entry.albumCoverPrimary = true;
                    } else if (!entry.albumCover) {
                        entry.albumCover = cover;
                    }
                }
                entry.songs.push(songEntry);
            } else {
                singles.push(songEntry);
            }
        }

        // Fallback: include cached songs where otsochodzi appears but weren't returned in getAllSongs
        try {
            const cachedSongs = genius.getAllCachedSongs ? genius.getAllCachedSongs() : [];
            const seenSongIds = new Set(allSongs.map(s => String(s.id)));
            for (const cs of cachedSongs) {
                if (!cs || !cs.id) continue;
                if (seenSongIds.has(String(cs.id))) continue;
                const artists = cs.artists || [];
                if (!artists.some(a => String(a.id) === String(otsochodziId))) continue;
                const album = cs.album || null;
                const cover = cs.cover || null;
                const songEntry = { id: cs.id, title: cs.title, cover, artists, dailyCount: dailyCounts[cs.id] || 0 };
                if (album && album.name) {
                    const key = String(album.id ?? album.name);
                    if (!albumMap.has(key)) {
                        albumMap.set(key, { albumId: key, albumName: album.name, albumCover: null, albumCoverPrimary: false, songs: [] });
                    }
                    const entry = albumMap.get(key);
                    if (cover) {
                        // prefer primary track covers (cachedSongs are from various sources — treat as primary here)
                        entry.albumCover = cover;
                    }
                    entry.songs.push(songEntry);
                } else {
                    singles.push(songEntry);
                }
            }
        } catch (e) {
            // ignore fallback errors
        }

        // Classify albums: main albums first, EPs next, appearance-only last.
        const albums = Array.from(albumMap.values()).map(a => {
            const total = a.songs.length || 0;
            const primaryCount = a.songs.reduce((c, s) => c + (s.artists && s.artists.some(ar => String(ar.id) === String(otsochodziId)) ? 1 : 0), 0);
            const isAppearanceOnly = primaryCount === 0;
            const isEP = /\bEP\b/i.test(a.albumName) || total > 0 && total <= 4;
            return Object.assign({}, a, { _total: total, _primaryCount: primaryCount, _rank: isAppearanceOnly ? 3 : (isEP ? 2 : 1) });
        }).sort((a, b) => {
            if (a._rank !== b._rank) return a._rank - b._rank;
            // For main albums prefer those with more primary tracks (likely core releases)
            if (a._rank === 1 && b._rank === 1 && a._primaryCount !== b._primaryCount) return b._primaryCount - a._primaryCount;
            return a.albumName.localeCompare(b.albumName, 'pl');
        });
        // Ensure album cover is used for all songs in the album (prefer explicit albumCover, fallback to first song cover)
        for (const alb of albums) {
            if (!alb.albumCover) {
                const found = (alb.songs || []).find(s => s.cover);
                if (found) alb.albumCover = found.cover;
            }
            if (alb.albumCover) {
                for (const s of alb.songs) {
                    if (!s.cover) s.cover = alb.albumCover;
                    else s.cover = alb.albumCover; // force album cover for consistency
                }
            }
        }
        if (singles.length) {
            albums.push({ albumId: '__singles__', albumName: 'Single / Inne', albumCover: null, songs: singles });
        }

        res.setHeader("Cache-Control", "public, max-age=300");
        res.json(albums);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to build discography" });
    }
});

app.get("/api/albums", async (req, res) => {
    if (!otsochodziId) return res.status(503).json({ error: "Server is initializing" });
    if (cachedAlbums) return res.json(cachedAlbums);
    try {
        const allSongs = await genius.getAllSongs(otsochodziId);
        const albumMap = new Map();
        for (const s of allSongs) {
            const cached = genius.getSongCacheEntry(s.id);
            const album = cached?.album ? cached.album : s.album;
            if (album?.name) {
                const key = String(album.id ?? album.name);
                if (!albumMap.has(key)) albumMap.set(key, { id: key, name: album.name, _total: 0, _primaryCount: 0 });
                const entry = albumMap.get(key);
                entry._total = (entry._total || 0) + 1;
                const artists = cached?.artists || s.artists || [];
                if (artists.some(a => String(a.id) === String(otsochodziId))) entry._primaryCount = (entry._primaryCount || 0) + 1;
            }
        }
        // Sort by same rules as /api/discography: main, EPs, appearances
        cachedAlbums = Array.from(albumMap.values()).map(a => {
            const isAppearanceOnly = (a._primaryCount || 0) === 0;
            const isEP = /\bEP\b/i.test(a.name) || (a._total || 0) > 0 && (a._total || 0) <= 4;
            return Object.assign({}, a, { _rank: isAppearanceOnly ? 3 : (isEP ? 2 : 1) });
        }).sort((a, b) => {
            if (a._rank !== b._rank) return a._rank - b._rank;
            if (a._rank === 1 && b._rank === 1 && (b._primaryCount || 0) !== (a._primaryCount || 0)) return (b._primaryCount || 0) - (a._primaryCount || 0);
            return a.name.localeCompare(b.name, 'pl');
        }).map(a => ({ id: a.id, name: a.name }));
        res.json(cachedAlbums);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch albums" });
    }
});

app.get("/api/daily-stats/:date", (req, res) => {
    const { date } = req.params;
    try {
        // Stats for past days never change — safe to cache for an hour.
        res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
        const day = db.getStatsByDate(date);
        const all = [...day.correct, ...day.giveup];
        if (!all.length) return res.json({ total: 0, correctCount: 0, buckets: [] });

        const max = Math.max(...all);
        // Pre-compute frequency counts in O(n) instead of O(n * buckets)
        const correctFreq = new Map();
        const giveupFreq  = new Map();
        for (const w of day.correct) correctFreq.set(w, (correctFreq.get(w) || 0) + 1);
        for (const w of day.giveup)  giveupFreq.set(w,  (giveupFreq.get(w)  || 0) + 1);
        const buckets = [];
        for (let i = 1; i <= Math.min(max, 30); i++) {
            buckets.push({
                words: i,
                correct: correctFreq.get(i) || 0,
                giveup:  giveupFreq.get(i)  || 0,
            });
        }
        res.json({ total: all.length, correctCount: day.correct.length, buckets });
    } catch (e) {
        res.status(500).json({ error: "Failed to read stats" });
    }
});

app.post("/api/daily-stats/:date", statsLimiter, (req, res) => {
    const { date } = req.params;
    const { wordsRevealed, outcome } = req.body;
    if (!date || typeof wordsRevealed !== "number" || !["correct","giveup"].includes(outcome)) {
        return res.status(400).json({ error: "Invalid payload" });
    }
    // Validate date is a real ISO date and not in the future
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date) > new Date()) {
        return res.status(400).json({ error: "Invalid date" });
    }
    const w = Math.max(1, Math.min(Math.floor(wordsRevealed), 500));
    try {
        db.addStat(date, outcome, w);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to write stats" });
    }
});

// ── Ranked: get next song ───────────────────────────────────
// Self-contained replacement for /api/game/endless in ranked mode.
// Picks a song, registers it as pendingId on the session, and returns the
// same payload shape so the frontend needs no other endpoint for ranked play.
app.get("/api/ranked/song", rankedSongLimiter, async (req, res) => {
    if (!otsochodziId) return res.status(503).json({ error: "Server is initializing, try again shortly" });

    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    const session = rankedSessions.get(String(sessionId));
    if (!session)          return res.status(404).json({ error: "Session not found" });
    if (session.finished)  return res.status(400).json({ error: "Session already finished" });

    const elapsed = Date.now() - session.startedAt;
    if (elapsed > RANKED_DURATION_MS + RANKED_GRACE_MS) {
        session.finished = true;
        return res.status(400).json({ error: "Session expired" });
    }

    try {
        const picked = await pickSong(otsochodziId, { usedSongs: session.usedSongs });
        if (!picked) return res.status(500).json({ error: "Could not find a song with lyrics" });
        const { song, moreSongInfo } = picked;
        session.pendingId = song.id;

        const words = await genius.getWordArray(song.id);
        res.json({
            songId:    song.id,
            title:     song.title,
            wordCount: words.length,
            words,
            cover:     moreSongInfo.cover || song.cover || null,
            artists:   moreSongInfo.artists || song.artists || [],
            featured:  moreSongInfo.featured || [],
            hints:     { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch ranked song" });
    }
});

// ── Ranked: start a session ──────────────────────────────────
app.post("/api/ranked/start", rankedStartLimiter, (req, res) => {
    const sessionId = crypto.randomBytes(32).toString("hex");
    rankedSessions.set(sessionId, {
        startedAt: Date.now(),
        score:     0,
        usedSongs: new Set(),
        pendingId: null,   // songId the server last issued via /api/game/endless
        finished:  false,
        submitted: false,
    });
    // Log ranked game play
    const rankedUid = req.body?.userId ? String(req.body.userId).trim().slice(0, 128)
        : (req.headers['x-user-id'] ? String(req.headers['x-user-id']).trim().slice(0, 128) : null);
    db.logGamePlay("ranked", rankedUid);
    res.json({ sessionId });
});

// ── Ranked: record a correct guess ───────────────────────────
// Only accepts the exact songId the server issued via /api/game/endless for
// this session. Arbitrary catalog IDs (from a pre-built list, etc.) are
// rejected — blocking automated-script attacks.
app.post("/api/ranked/correct", rankedCorrectLimiter, (req, res) => {
    const { sessionId, songId } = req.body;
    if (!sessionId || !songId) return res.status(400).json({ error: "Missing fields" });

    const session = rankedSessions.get(String(sessionId));
    if (!session)          return res.status(404).json({ error: "Session not found" });
    if (session.finished)  return res.status(400).json({ error: "Session already finished" });

    const elapsed = Date.now() - session.startedAt;
    if (elapsed > RANKED_DURATION_MS + RANKED_GRACE_MS) {
        session.finished = true;
        return res.status(400).json({ error: "Session expired" });
    }

    const songIdInt = parseInt(songId, 10);
    if (!Number.isInteger(songIdInt) || songIdInt <= 0)
        return res.status(400).json({ error: "Invalid songId" });

    // Core defence: must match the song the server issued to this session.
    if (session.pendingId === null)
        return res.status(400).json({ error: "No pending song for this session" });
    if (songIdInt !== session.pendingId)
        return res.status(400).json({ error: "Song not issued to this session" });

    if (session.score >= MAX_RANKED_SONGS)
        return res.status(400).json({ error: "Score ceiling reached" });

    session.usedSongs.add(songIdInt);
    session.pendingId = null;  // consumed — client must fetch next song via /api/game/endless
    session.score++;
    res.json({ score: session.score });
});

app.get("/api/leaderboard/monthly", (req, res) => {
    try {
        res.setHeader("Cache-Control", "public, max-age=300");
        const data = db.getRankedByMonth();
        res.json(data.map(r => ({
            month: r.month,
            submissions: r.submissions,
            avgScore: Math.round((r.avgScore || 0) * 10) / 10,
            topScore: r.topScore || 0,
        })));
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch monthly leaderboard" });
    }
});

app.get("/api/leaderboard", (req, res) => {
    try {
        const limitParam = parseInt(req.query.limit, 10);
        const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 20;
        res.setHeader("Cache-Control", "public, max-age=30");
        res.json(db.getLeaderboard(limit));
    } catch (e) {
        res.status(500).json({ error: "Failed to read leaderboard" });
    }
});

// ── Leaderboard submit: requires a valid server-side session ──
app.post("/api/leaderboard", leaderboardLimiter, (req, res) => {
    const { name, sessionId, userId } = req.body;
    if (!name || !sessionId) return res.status(400).json({ error: "Missing name or sessionId" });

    const session = rankedSessions.get(String(sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Game must be over (timer expired)
    const elapsed = Date.now() - session.startedAt;
    if (elapsed < RANKED_DURATION_MS - 2000 && !session.finished)
        return res.status(400).json({ error: "Game not finished yet" });

    // Single-use token: prevent re-submitting the same session
    if (session.submitted) return res.status(400).json({ error: "Score already submitted" });
    session.submitted = true;
    session.finished  = true;

    const score    = session.score;
    const safeName = String(name).replace(/[<>&"]/g, "").trim().slice(0, 32);
    if (!safeName) return res.status(400).json({ error: "Invalid name" });

    const safeUserId = userId ? String(userId).trim().slice(0, 128) : null;
    const today = new Date().toISOString().split("T")[0];
    const rank = db.insertLeaderboard({ name: safeName, score, date: today, user_id: safeUserId });
    res.json({ rank: rank || 0 });
});

// ── 404 catch-all ───────────────────────────────────────────
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, "public/views/404.html"));
});

const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// ── Graceful shutdown ────────────────────────────────────────
function shutdown(signal) {
    console.log(`[${signal}] Shutting down gracefully…`);
    genius.flushSongCache(); // flush any pending debounced cache write
    server.close(() => {
        console.log("[SHUTDOWN] HTTP server closed");
        process.exit(0);
    });
    // Force-exit if connections don't drain within 10 s
    setTimeout(() => {
        console.error("[SHUTDOWN] Forced exit after timeout");
        process.exit(1);
    }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
    console.error("[FATAL] Uncaught exception:", err);
    shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] Unhandled rejection:", reason);
    shutdown("unhandledRejection");
});