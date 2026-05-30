require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const genius = require("./utils/genius");
const db = require("./utils/db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(express.json({ limit: "16kb" }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const statsLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const leaderboardLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });
const lyricsLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

let otsochodziId = null;
genius.getArtistIdByName("otsochodzi").then((artistId) => {
  otsochodziId = artistId;
  console.log(`Artist ID for Otsochodzi: ${artistId}`);
  genius.getAllSongs(artistId).then((songs) => {
    console.log(`Songs for Otsochodzi: ${songs.length}`);
  });
});

app.use(express.static("public"))

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/index.html"));
})

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/admin.html"));
})

app.get("/regulamin", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/regulamin.html"));
})

app.get("/polityka-prywatnosci", (req, res) => {
    res.sendFile(path.join(__dirname, "public/views/polityka-prywatnosci.html"));
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
    const auth = req.headers["x-admin-password"] || "";
    if (!timingSafeEqual(auth, pwd)) return res.status(401).json({ error: "Unauthorized" });
    next();
}

app.post("/api/admin/login", loginLimiter, (req, res) => {
    const pwd = process.env.ADMIN_PASSWORD;
    if (!pwd) return res.status(500).json({ error: "ADMIN_PASSWORD not set" });
    if (timingSafeEqual(String(req.body.password || ""), pwd)) res.json({ ok: true });
    else res.status(401).json({ error: "Wrong password" });
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
        const daily = db.getDaily();
        const idx = daily.findIndex(e => e.date === date);
        if (idx >= 0) daily[idx] = { date, songID, wordIndex };
        else daily.push({ date, songID, wordIndex });
        daily.sort((a, b) => a.date.localeCompare(b.date));
        db.writeDaily(daily);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to write daily" });
    }
})

app.delete("/api/admin/daily/:date", adminAuth, (req, res) => {
    try {
        const filtered = db.getDaily().filter(e => e.date !== req.params.date);
        db.writeDaily(filtered);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to write daily" });
    }
})

app.get("/api/admin/stats-overview", adminAuth, (req, res) => {
    try {
        const raw = db.getStats();   // { "YYYY-MM-DD": { correct: [], giveup: [] } }
        const dates = Object.keys(raw).sort();
        if (!dates.length) return res.json({ dates: [], perDay: [], totals: { plays: 0, correct: 0, giveup: 0 }, streaks: {} });

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

        res.json({ dates, perDay, byMonth: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)), totals });
    } catch (e) {
        res.status(500).json({ error: "Failed to build stats overview" });
    }
})


const SKIP_PATTERNS = /\b(skit|interlude|acapella|remix|freestyle|cypher|intro|outro|bonus|relacja|remaster)\b/i;

app.get("/api/game/endless", async (req, res) => {
    if (!otsochodziId) return res.status(503).json({ error: "Server is initializing, try again shortly" });
    try {
        const allSongs = await genius.getAllSongs(otsochodziId);
        if (!allSongs.length) return res.status(503).json({ error: "Song list unavailable" });
        const filtered = allSongs.filter(s => !SKIP_PATTERNS.test(s.title));

        // Classify using per-song cache (has album data from /songs/{id} calls).
        // Songs not yet individually fetched are treated as potential album tracks
        // since the vast majority of Otsochodzi's catalog is from proper albums.
        const isPrimary = (s) => s.artists.some(a => String(a.id) === String(otsochodziId));
        const albumTracks = [], features = [], singles = [], unclassified = [];
        for (const s of filtered) {
            const cached = genius.getSongCacheEntry(s.id);
            if (!isPrimary(s)) {
                features.push(s);
            } else if (!cached) {
                unclassified.push(s); // not fetched yet — assume album track
            } else if (cached.album) {
                albumTracks.push(s);
            } else {
                singles.push(s);
            }
        }
        // merge confirmed album tracks + unclassified into the "album" pool
        const albumPool = [...albumTracks, ...unclassified];

        function pickBucket() {
            const roll = Math.random();
            if (roll < 0.70 && albumPool.length)  return albumPool;
            if (roll < 0.90 && features.length)   return features;
            if (singles.length)                    return singles;
            return albumPool.length ? albumPool : filtered;
        }

        let moreSongInfo = null;
        let song = null;
        for (let i = 0; i < 15; i++) {
            const pool = pickBucket();
            song = pool[Math.floor(Math.random() * pool.length)];
            moreSongInfo = await genius.getSongById(song.id);
            if (moreSongInfo?.lyrics) break;
            moreSongInfo = null;
        }
        if (!moreSongInfo?.lyrics) return res.status(500).json({ error: "Could not find a song with lyrics" });

        const words = moreSongInfo.lyrics.split(/\s+/).filter(Boolean);
        res.json({
            songId: song.id,
            title: song.title,
            wordCount: words.length,
            cover: moreSongInfo.cover || song.cover || null,
            artists: moreSongInfo.artists || song.artists || [],
            featured: moreSongInfo.featured || [],
            hints: { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch song" });
    }
});

app.get("/api/game/daily/:date", async (req, res) => {
    const { date } = req.params;
    try {
        if (new Date(date) > new Date()) {
            return res.status(400).json({ error: "Date cannot be in the future" });
        }
        
        const dailyData = db.getDaily().find(entry => entry.date === date);
        if (!dailyData) {
            return res.status(404).json({ error: "No game found for this date" });
        }

        const { songID, wordIndex } = dailyData;
        const moreSongInfo = await genius.getSongById(songID);
        res.json({
            songId: songID,
            title: moreSongInfo.title,
            cover: moreSongInfo.cover || null,
            artists: moreSongInfo.artists || [],
            featured: moreSongInfo.featured || [],
            hints: { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate },
            wordIndex
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
        const lyrics = (await genius.getSongById(songIdInt)).lyrics;
        const words = lyrics.split(/\s+/);
        if (wordIndex < 0 || wordIndex >= words.length) {
            return res.status(400).json({ error: "Invalid wordIndex" });
        }
        res.json({ word: words[wordIndex] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch lyrics" });
    }
});

app.get("/api/autocomplete/songs", async (req, res) => {
    const { query } = req.query;
    if (!query) {
        return res.status(400).json({ error: "Missing query parameter" });
    }

    try {
        const songs = await genius.searchCachedSongsByName(query);
        res.json(songs.map(song => ({ id: song.id, title: song.title, cover: song.cover||null, artists: song.artists||[] })));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch autocomplete suggestions" });
    }
});

app.get("/api/daily-stats/:date", (req, res) => {
    const { date } = req.params;
    try {
        const stats = db.getStats();
        const day = stats[date] || { correct: [], giveup: [] };
        const all = [...day.correct, ...day.giveup];
        if (!all.length) return res.json({ total: 0, correctCount: 0, buckets: [] });

        const max = Math.max(...all);
        const buckets = [];
        for (let i = 1; i <= Math.min(max, 30); i++) {
            buckets.push({
                words: i,
                correct: day.correct.filter(w => w === i).length,
                giveup: day.giveup.filter(w => w === i).length,
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
        const stats = db.getStats();
        if (!stats[date]) stats[date] = { correct: [], giveup: [] };
        stats[date][outcome].push(w);
        db.writeStats(stats);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to write stats" });
    }
});

app.get("/api/leaderboard", (req, res) => {
    try {
        const board = db.getLeaderboard();
        board.sort((a, b) => b.score - a.score);
        res.json(board.slice(0, 20));
    } catch (e) {
        res.status(500).json({ error: "Failed to read leaderboard" });
    }
});

app.post("/api/leaderboard", leaderboardLimiter, (req, res) => {
    const { name, score } = req.body;
    if (!name || typeof score !== "number") return res.status(400).json({ error: "Missing name or score" });
    if (!Number.isInteger(score) || score < 0 || score > 100000) return res.status(400).json({ error: "Invalid score" });
    const safeName = String(name).replace(/[<>&"]/g, "").trim().slice(0, 32);
    if (!safeName) return res.status(400).json({ error: "Invalid name" });
    const board = db.getLeaderboard();
    board.push({ name: safeName, score, date: new Date().toISOString().split("T")[0] });
    board.sort((a, b) => b.score - a.score);
    db.writeLeaderboard(board);
    res.json({ rank: board.findIndex(e => e.name === safeName && e.score === score && e.date === new Date().toISOString().split("T")[0]) + 1 });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});