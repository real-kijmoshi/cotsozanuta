const express = require("express");
const genius = require("../../utils/genius");
const db = require("../../utils/db");
const state = require("../state");
const { adminAuth, timingSafeEqual } = require("../middleware/adminAuth");
const { loginLimiter } = require("../rateLimiters");
const jwt = require("jsonwebtoken");

const router = express.Router();

function calcMedian(arr) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2 * 10) / 10;
}

router.post("/login", loginLimiter, (req, res) => {
    const pwd = process.env.ADMIN_PASSWORD;
    if (!pwd) return res.status(500).json({ error: "ADMIN_PASSWORD not set" });
    if (!timingSafeEqual(String(req.body.password || ""), pwd)) return res.status(401).json({ error: "Wrong password" });
    const secret = process.env.ADMIN_JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "JWT secret not configured" });
    const token = jwt.sign({ admin: true }, secret, { expiresIn: process.env.ADMIN_JWT_EXPIRES || '12h' })
    res.json({ ok: true, token })
})

router.get("/songs", adminAuth, async (req, res) => {
    try {
        const songs = await genius.getAllSongs(state.otsochodziId);
        res.json(songs.map(s => ({ id: s.id, title: s.title, cover: s.cover || null, artists: s.artists || [] })));
    } catch (e) {
        console.error("[admin] songs:", e.message);
        res.status(500).json({ error: "Failed to fetch songs" });
    }
})

router.get("/lyrics/:songId", adminAuth, async (req, res) => {
    const songIdInt = parseInt(req.params.songId, 10);
    if (!Number.isInteger(songIdInt) || songIdInt <= 0) {
        return res.status(400).json({ error: "Invalid songId" });
    }
    if (!state.otsochodziId || !genius.isArtistSong(state.otsochodziId, songIdInt)) {
        return res.status(404).json({ error: "Song not in Otsochodzi catalog" });
    }
    try {
        const info = await genius.getSongById(songIdInt);
        if (!info?.lyrics) return res.status(404).json({ error: "No lyrics found" });
        res.json({ lyrics: info.lyrics, title: info.title, cover: info.cover || null, wordCount: info.lyrics.split(/\s+/).filter(Boolean).length });
    } catch (e) {
        console.error("[admin] lyrics:", e.message);
        res.status(500).json({ error: "Failed to fetch lyrics" });
    }
})

router.get("/daily", adminAuth, (req, res) => {
    try {
        res.json(db.getDaily());
    } catch (e) {
        console.error("[admin] daily GET:", e.message);
        res.status(500).json({ error: "Failed to read daily" });
    }
})

router.post("/daily", adminAuth, (req, res) => {
    const { date, songID, wordIndex } = req.body;
    if (!date || !songID || typeof wordIndex !== "number") return res.status(400).json({ error: "Missing fields" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date format" });
    if (wordIndex < 0 || !Number.isInteger(wordIndex)) return res.status(400).json({ error: "Invalid wordIndex" });
    try {
        db.upsertDaily({ date, songID, wordIndex });
        res.json({ ok: true });
    } catch (e) {
        console.error("[admin] daily POST:", e.message);
        res.status(500).json({ error: "Failed to write daily" });
    }
})

router.delete("/daily/:date", adminAuth, (req, res) => {
    try {
        db.deleteDaily(req.params.date);
        res.json({ ok: true });
    } catch (e) {
        console.error("[admin] daily DELETE:", e.message);
        res.status(500).json({ error: "Failed to write daily" });
    }
})

router.get("/stats-overview", adminAuth, (req, res) => {
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

        // ── Game Plays detailed breakdown (Daily, Endless, Ranked, Audio) ──
        // "text" modes = lyric-based (daily, endless, ranked); "audio" = guess-by-sound.
        // We keep them separate everywhere so the two experiences can be compared.
        const gamePlaysRaw = db.getGamePlays(); // [{ mode, date, count }]
        const playsByDate = {}; // { "YYYY-MM-DD": { endless, ranked, daily, audio } }
        const blank = () => ({ endless: 0, ranked: 0, daily: 0, audio: 0 });

        // Populate endless, ranked and audio from game_plays
        for (const row of gamePlaysRaw) {
            if (!playsByDate[row.date]) playsByDate[row.date] = blank();
            if (row.mode === "endless") playsByDate[row.date].endless += row.count;
            if (row.mode === "ranked")  playsByDate[row.date].ranked  += row.count;
            if (row.mode === "audio")   playsByDate[row.date].audio   += row.count;
        }

        // Populate daily completions from daily_stats (for backward compatibility and total accuracy)
        for (const d of perDay) {
            if (!playsByDate[d.date]) playsByDate[d.date] = blank();
            playsByDate[d.date].daily += d.plays; // daily plays = correct + giveup in daily_stats
        }

        // Build a sorted array of all unique dates and their breakdown
        const allStatsDates = Array.from(new Set([
            ...Object.keys(playsByDate),
            ...dates
        ])).sort();

        const gamePlaysBreakdown = allStatsDates.map(d => {
            const p = playsByDate[d] || blank();
            const text = p.daily + p.endless + p.ranked;
            return {
                date: d,
                daily: p.daily,
                endless: p.endless,
                ranked: p.ranked,
                audio: p.audio,
                text,                       // sum of lyric-based modes
                total: text + p.audio
            };
        });

        const totalEndless = gamePlaysBreakdown.reduce((s, g) => s + g.endless, 0);
        const totalRanked  = gamePlaysBreakdown.reduce((s, g) => s + g.ranked, 0);
        const totalDaily   = gamePlaysBreakdown.reduce((s, g) => s + g.daily, 0);
        const totalAudio   = gamePlaysBreakdown.reduce((s, g) => s + g.audio, 0);
        const totalText    = totalEndless + totalRanked + totalDaily;
        const totalPlaysAll = totalText + totalAudio;

        // ── Avg & median games per unique user (overall + per category) ──
        const uniqueUsers = db.getUniqueUserCount().total || 0;
        const avgGamesPerUser = uniqueUsers ? Math.round(totalPlaysAll / uniqueUsers * 10) / 10 : null;
        const gamesPerUserRows = db.getGamesPerUser(); // already sorted ASC by games
        const medianGamesPerUser = calcMedian(gamesPerUserRows.map(r => r.games));

        // Per-category games/user: how much a user plays audio vs text.
        const perCatRows = db.getGamesPerUserByCat(); // [{ user_id, category, games }]
        const textGamesByUser  = perCatRows.filter(r => r.category === "text").map(r => r.games);
        const audioGamesByUser = perCatRows.filter(r => r.category === "audio").map(r => r.games);
        const gamesPerUserByCat = {
            text:  { avg: textGamesByUser.length  ? Math.round(totalText  / textGamesByUser.length  * 10) / 10 : null, median: calcMedian(textGamesByUser),  players: textGamesByUser.length },
            audio: { avg: audioGamesByUser.length ? Math.round(totalAudio / audioGamesByUser.length * 10) / 10 : null, median: calcMedian(audioGamesByUser), players: audioGamesByUser.length },
        };

        const monthlyGamePlays = {}; // { "YYYY-MM": { daily, endless, ranked, audio, text, total } }
        for (const g of gamePlaysBreakdown) {
            const m = g.date.slice(0, 7);
            if (!monthlyGamePlays[m]) {
                monthlyGamePlays[m] = { month: m, daily: 0, endless: 0, ranked: 0, audio: 0, text: 0, total: 0 };
            }
            monthlyGamePlays[m].daily   += g.daily;
            monthlyGamePlays[m].endless += g.endless;
            monthlyGamePlays[m].ranked  += g.ranked;
            monthlyGamePlays[m].audio   += g.audio;
            monthlyGamePlays[m].text    += g.text;
            monthlyGamePlays[m].total   += g.total;
        }
        const monthlyGamePlaysList = Object.values(monthlyGamePlays).sort((a,b) => a.month.localeCompare(b.month));

        // ── Country breakdown (from game_plays) ──────────────────
        const countryRows = db.getPlaysByCountry();
        const usersByCountry = db.getUniqueUsersByCountry();
        const countryMap = {};
        for (const r of countryRows) {
            if (!countryMap[r.country]) countryMap[r.country] = { country: r.country, text: 0, audio: 0, total: 0, users: 0 };
            countryMap[r.country][r.category] += r.count;
            countryMap[r.country].total += r.count;
        }
        for (const r of usersByCountry) {
            if (!countryMap[r.country]) countryMap[r.country] = { country: r.country, text: 0, audio: 0, total: 0, users: 0 };
            countryMap[r.country].users = r.users;
        }
        const countries = Object.values(countryMap).sort((a, b) => b.total - a.total);

        // ════════════════════════════════════════════════════════════
        // COMPREHENSIVE GAME RESULTS (from game_results table)
        // ════════════════════════════════════════════════════════════

        // Helper: percentiles from sorted array
        const percentile = (sorted, p) => {
            if (!sorted.length) return null;
            const idx = Math.ceil(p / 100 * sorted.length) - 1;
            return sorted[Math.max(0, idx)];
        };

        // ── Per-mode totals ────────────────────────────────────────
        const modeTotals = db.getGameResultModeTotals();
        const modeMap = {};
        for (const r of modeTotals) {
            modeMap[r.mode] = {
                total: r.total,
                wins: r.wins,
                giveups: r.giveups,
                winRate: r.total ? Math.round(r.wins / r.total * 100) : 0,
                avgWords: r.avgWords ? Math.round(r.avgWords * 10) / 10 : null,
                minWords: r.minWords,
                maxWords: r.maxWords,
                avgDuration: r.avgDuration ? Math.round(r.avgDuration) : null,
            };
        }

        // ── Games per user distribution ────────────────────────────
        const gpuRows = db.getGameResultGamesPerUser();
        const gpuAll = gpuRows.map(r => r.games).sort((a, b) => a - b);
        const gpuAudio = gpuRows.map(r => r.audio_games).sort((a, b) => a - b);
        const gpuText = gpuRows.map(r => r.text_games).sort((a, b) => a - b);
        const totalGr = gpuAll.reduce((s, v) => s + v, 0);
        const gamesPerUserDist = {
            total: gpuRows.length,
            totalGames: totalGr,
            avg: gpuRows.length ? Math.round(totalGr / gpuRows.length * 10) / 10 : null,
            median: calcMedian(gpuAll),
            p25: percentile(gpuAll, 25),
            p75: percentile(gpuAll, 75),
            p90: percentile(gpuAll, 90),
            p95: percentile(gpuAll, 95),
            max: gpuAll.length ? gpuAll[gpuAll.length - 1] : null,
            audio: {
                players: gpuRows.filter(r => r.audio_games > 0).length,
                avg: gpuRows.length ? Math.round(gpuAudio.reduce((s, v) => s + v, 0) / gpuRows.length * 10) / 10 : null,
                median: calcMedian(gpuAudio),
                p75: percentile(gpuAudio, 75),
            },
            text: {
                players: gpuRows.filter(r => r.text_games > 0).length,
                avg: gpuRows.length ? Math.round(gpuText.reduce((s, v) => s + v, 0) / gpuRows.length * 10) / 10 : null,
                median: calcMedian(gpuText),
                p75: percentile(gpuText, 75),
            },
        };

        // ── Win streaks per user ───────────────────────────────────
        const streakRows = db.getGameResultStreaks();
        const userStreaks = {};
        for (const r of streakRows) {
            if (!userStreaks[r.user_id]) userStreaks[r.user_id] = { current: 0, best: 0, lastOutcome: null, lastTimestamp: 0 };
            const s = userStreaks[r.user_id];
            if (s.lastOutcome === "correct" && r.outcome === "correct" && r.timestamp - s.lastTimestamp < 86400000 * 3) {
                s.current++;
            } else if (r.outcome === "correct") {
                s.current = 1;
            } else {
                s.current = 0;
            }
            s.best = Math.max(s.best, s.current);
            s.lastOutcome = r.outcome;
            s.lastTimestamp = r.timestamp;
        }
        const allUserStreaks = Object.values(userStreaks);
        const streakDist = {
            avg: allUserStreaks.length ? Math.round(allUserStreaks.reduce((s, v) => s + v.current, 0) / allUserStreaks.length * 10) / 10 : null,
            median: calcMedian(allUserStreaks.map(s => s.current)),
            bestMedian: calcMedian(allUserStreaks.map(s => s.best)),
            bestMax: allUserStreaks.length ? Math.max(...allUserStreaks.map(s => s.best)) : 0,
            usersOnStreak: allUserStreaks.filter(s => s.current >= 2).length,
            usersOnStreak5: allUserStreaks.filter(s => s.current >= 5).length,
        };

        // ── DAU / WAU / MAU from game_results ─────────────────────
        const grDau = db.getGameResultDauByDate();
        const last30Dau = grDau.slice(-30).map(r => r.dau);
        const last7Dau  = grDau.slice(-7).map(r => r.dau);
        const dauMetrics = {
            today: grDau.length ? grDau[grDau.length - 1].dau : 0,
            avg7d: last7Dau.length ? Math.round(last7Dau.reduce((s, v) => s + v, 0) / last7Dau.length) : 0,
            avg30d: last30Dau.length ? Math.round(last30Dau.reduce((s, v) => s + v, 0) / last30Dau.length) : 0,
            peak: grDau.length ? Math.max(...grDau.map(r => r.dau)) : 0,
        };

        // ── Word distribution per mode ─────────────────────────────
        const wordDistRows = db.getGameResultWordDist();
        const wordDistByMode = {};
        for (const r of wordDistRows) {
            if (!wordDistByMode[r.mode]) wordDistByMode[r.mode] = [];
            wordDistByMode[r.mode].push({ words: r.words, total: r.total, correct: r.correct, giveup: r.giveup });
        }

        // ── Country breakdown from game_results (per mode) ─────────
        const grCountryRows = db.getGameResultByCountry();
        const grCountryMap = {};
        for (const r of grCountryRows) {
            if (!grCountryMap[r.country]) grCountryMap[r.country] = { country: r.country, modes: {}, total: 0 };
            grCountryMap[r.country].modes[r.mode] = { total: r.total, wins: r.wins };
            grCountryMap[r.country].total += r.total;
        }
        const grCountries = Object.values(grCountryMap).sort((a, b) => b.total - a.total);

        // ── Retention: WAU returning week-over-week ────────────────
        const wauRows = db.getGameResultWauByWeek();
        const retention = [];
        for (let i = 1; i < wauRows.length; i++) {
            const prev = wauRows[i - 1];
            const curr = wauRows[i];
            retention.push({
                week: curr.year + '-W' + curr.week,
                wau: curr.wau,
                prevWau: prev.wau,
            });
        }

        res.json({
            // Legacy fields (kept for backward compat)
            dates, perDay, totals,
            byMonth: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
            streak: { current: currentStreak, best: bestStreak },
            peakDay,
            trends: { week: weekTrend, month: monthTrend, thisWeekPlays, lastWeekPlays, thisMonthPlays, lastMonthPlays },
            avgWords: { correct: avgWordsCorrect, giveup: avgWordsGiveup },
            medianWords: { correct: medianWordsCorrect, giveup: medianWordsGiveup },
            wordDistribution, peakBucket,
            avgGamesPerUser, medianGamesPerUser,
            gamesPerUserByCat,
            countries,
            gamePlays: {
                breakdown: gamePlaysBreakdown,
                totals: { daily: totalDaily, endless: totalEndless, ranked: totalRanked, audio: totalAudio, text: totalText, all: totalPlaysAll },
                monthly: monthlyGamePlaysList,
            },

            // ═══ NEW COMPREHENSIVE DATA ═══
            comprehensive: {
                modeTotals,                          // per-mode: total, wins, giveups, winRate, avgWords, avgDuration
                gamesPerUserDist,                    // full distribution with percentiles, audio vs text split
                streakDist,                          // streak stats across all users
                dauMetrics,                          // DAU today, avg7d, avg30d, peak
                wordDistByMode,                      // word distribution broken down per mode
                grCountries,                         // country breakdown per mode from game_results
                retention,                           // week-over-week WAU retention
                totalGameResults: modeTotals.reduce((s, m) => s + m.total, 0),
            },
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to build stats overview" });
    }
})

router.get("/ranked-overview", adminAuth, (req, res) => {
    try {
        const mode     = db.normalizeMode(req.query.mode);
        const gameType = db.normalizeGameType(req.query.gameType);
        const stats    = db.getRankedStats(mode, gameType);
        const byMonth  = db.getRankedByMonth(mode, gameType).map(r => ({
            month:       r.month,
            submissions: r.submissions,
            avgScore:    Math.round((r.avgScore || 0) * 10) / 10,
            topScore:    r.topScore || 0,
        }));
        const topScores = db.getLeaderboard(mode, gameType, 10);
        res.json({
            mode,
            gameType,
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

router.get("/users-overview", adminAuth, (req, res) => {
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

router.get("/song-health", adminAuth, (req, res) => {
    try {
        const allSongs = state.songHealth;
        const total = allSongs.size;
        const ok = [];
        const failed = [];
        for (const [id, h] of allSongs) {
            const record = { id, ...h };
            if (h.hasLyrics && h.hasDeezer) ok.push(record);
            else failed.push(record);
        }
        res.json({ total, ok: ok.length, failed: failed.length, songs: [...failed, ...ok] });
    } catch (e) {
        console.error("[admin] song-health:", e.message);
        res.status(500).json({ error: "Failed to fetch song health" });
    }
})

// ── SONG RECHECK ─────────────────────────────────────────────
// Streams progress via SSE while re-fetching Genius metadata for all songs.
router.get("/recheck", adminAuth, async (req, res) => {
  const { SKIP_PATTERNS } = require("../config");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let closed = false;
  req.on("close", () => { closed = true; });

  try {
    const allSongs = await genius.getAllSongs(state.otsochodziId);
    if (closed) return;
    const eligible = allSongs.filter(s => !SKIP_PATTERNS.test(s.title));
    const BATCH = 5, DELAY = 800;

    res.write(`data:${JSON.stringify({ phase: "start", total: eligible.length })}\n\n`);

    for (let i = 0; i < eligible.length; i += BATCH) {
      if (closed) break;
      const batch = eligible.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(s => genius.getSongById(s.id)));
      for (let j = 0; j < batch.length; j++) {
        const s = batch[j];
        const r = results[j];
        const info = r.status === "fulfilled" ? r.value : null;
        const errMsg = r.status === "rejected" ? r.reason?.message || "unknown" : (!info ? "no data" : null);
        state.songHealth.set(s.id, {
          title: s.title,
          cover: s.cover || null,
          hasLyrics: !!(info && info.lyrics),
          hasDeezer: !!(info && info.deezerId),
          hasAlbum: !!(info && info.album),
          lastError: errMsg,
          checkedAt: new Date().toISOString(),
        });
      }
      const done = Math.min(i + BATCH, eligible.length);
      res.write(`data:${JSON.stringify({ phase: "progress", current: done, total: eligible.length })}\n\n`);
      if (i + BATCH < eligible.length) await new Promise(r => setTimeout(r, DELAY));
    }

    if (!closed) res.write(`data:${JSON.stringify({ phase: "done" })}\n\n`);
  } catch (e) {
    if (!closed) res.write(`data:${JSON.stringify({ phase: "error", message: e.message })}\n\n`);
  }
  if (!closed) res.end();
})

// ── SET DEEZER TRACK FOR A SONG ───────────────────────────────
// Manual override for songs the auto-matcher misses (remixes, obscure titles).
// Takes a Deezer track URL (or bare numeric id) — NOT a preview URL, which
// expires; we store the permanent track id and resolve a fresh preview at
// serve time (see genius.resolveDeezerPreview).
router.post("/set-deezer", adminAuth, async (req, res) => {
  const { songId, deezerUrl } = req.body;
  const songIdInt = parseInt(songId, 10);
  if (!Number.isInteger(songIdInt) || songIdInt <= 0) return res.status(400).json({ error: "Invalid songId" });
  if (!deezerUrl || typeof deezerUrl !== "string") return res.status(400).json({ error: "Missing deezerUrl" });

  const deezerId = genius.extractDeezerTrackId(deezerUrl);
  if (!deezerId) return res.status(400).json({ error: "Could not extract a Deezer track id from URL" });

  const preview = await genius.resolveDeezerPreview(deezerId);
  if (!preview) return res.status(400).json({ error: "That Deezer track has no preview available" });

  // Store in Genius cache
  genius.setDeezerTrackId(songIdInt, deezerId);

  // Update songHealth
  const prev = state.songHealth.get(songIdInt) || { title: `#${songIdInt}`, cover: null, hasLyrics: false, hasDeezer: false, hasAlbum: false, lastError: null, checkedAt: null };
  prev.hasDeezer = true;
  prev.lastError = null;
  prev.checkedAt = new Date().toISOString();
  state.songHealth.set(songIdInt, prev);

  res.json({ ok: true, deezerId, previewUrl: preview });
})

// ── Toasts CRUD ──────────────────────────────────────────────
router.get("/toasts", adminAuth, (req, res) => {
    try {
        res.json(db.getAllToasts());
    } catch (e) {
        console.error("[admin] toasts GET:", e.message);
        res.status(500).json({ error: "Failed to fetch toasts" });
    }
})

router.get("/toasts/:id", adminAuth, (req, res) => {
    try {
        const t = db.getToastById(parseInt(req.params.id, 10));
        if (!t) return res.status(404).json({ error: "Toast not found" });
        res.json(t);
    } catch (e) {
        console.error("[admin] toast GET by id:", e.message);
        res.status(500).json({ error: "Failed to fetch toast" });
    }
})

router.post("/toasts", adminAuth, (req, res) => {
    try {
        const { title, subtitle, icon, bg_color, border_color, accent_color, position, duration, start_date, end_date, once_per_user, enabled } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ error: "Title is required" });
        const id = db.insertToast({
            title: title.trim(), subtitle: subtitle||'', icon: icon||'🔔',
            bg_color: bg_color||'', border_color: border_color||'', accent_color: accent_color||'',
            position: position||'top', duration: typeof duration==='number' ? duration : 6500,
            start_date: start_date||null, end_date: end_date||null,
            once_per_user: once_per_user !== false, enabled: enabled !== false,
        });
        res.json({ ok: true, id });
    } catch (e) {
        console.error("[admin] toast POST:", e.message);
        res.status(500).json({ error: "Failed to create toast" });
    }
})

router.put("/toasts/:id", adminAuth, (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const existing = db.getToastById(id);
        if (!existing) return res.status(404).json({ error: "Toast not found" });
        const { title, subtitle, icon, bg_color, border_color, accent_color, position, duration, start_date, end_date, once_per_user, enabled } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ error: "Title is required" });
        db.updateToast(id, {
            title: title.trim(), subtitle: subtitle||'', icon: icon||'🔔',
            bg_color: bg_color||'', border_color: border_color||'', accent_color: accent_color||'',
            position: position||'top', duration: typeof duration==='number' ? duration : 6500,
            start_date: start_date||null, end_date: end_date||null,
            once_per_user: once_per_user !== false, enabled: enabled !== false,
        });
        res.json({ ok: true });
    } catch (e) {
        console.error("[admin] toast PUT:", e.message);
        res.status(500).json({ error: "Failed to update toast" });
    }
})

router.delete("/toasts/:id", adminAuth, (req, res) => {
    try {
        db.deleteToast(parseInt(req.params.id, 10));
        res.json({ ok: true });
    } catch (e) {
        console.error("[admin] toast DELETE:", e.message);
        res.status(500).json({ error: "Failed to delete toast" });
    }
})

module.exports = router;
