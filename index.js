require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
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

const SKIP_PATTERNS = /\b(skit|interlude|acapella|remix|freestyle|cypher|intro|outro|bonus|relacja|remaster)\b/i;

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
      })();
    } else {
      console.log(`[WARM] All ${allSongs.length} songs already cached`);
    }
  } catch (e) {
    console.error("[WARM] Startup warm-up failed:", e.message);
  }
})();

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

app.get("/api/admin/stats-overview", adminAuth, (req, res) => {
    try {
        const raw = db.getAllStats();  // { "YYYY-MM-DD": { correct: [], giveup: [] } }
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


app.get("/api/game/endless", async (req, res) => {
    if (!otsochodziId) return res.status(503).json({ error: "Server is initializing, try again shortly" });

    const { sessionId } = req.query;
    const rankedSession = sessionId ? rankedSessions.get(String(sessionId)) : null;

    try {
        const allSongs = await genius.getAllSongs(otsochodziId);
        if (!allSongs.length) return res.status(503).json({ error: "Song list unavailable" });
        const filtered = allSongs.filter(s => !SKIP_PATTERNS.test(s.title));

        const isPrimary = (s) => s.artists.some(a => String(a.id) === String(otsochodziId));
        const albumTracks = [], features = [], singles = [];
        for (const s of filtered) {
            const cached = genius.getSongCacheEntry(s.id);
            // Prefer per-song cache (has full data); fall back to album field from artist list.
            const album = cached?.album !== undefined ? cached.album : s.album;
            if (!isPrimary(s)) {
                features.push(s);
            } else if (album) {
                albumTracks.push(s);
            } else {
                singles.push(s);
            }
        }
        const albumPool = albumTracks;

        // Album filter (endless mode only; ignored in ranked)
        let customPool = null;
        const albumsParam = !rankedSession ? String(req.query.albums || '').trim() : '';
        if (albumsParam) {
            const albumIds = new Set(albumsParam.split(',').slice(0, 50).map(a => a.trim()).filter(Boolean));
            const albumFiltered = filtered.filter(s => {
                const cached = genius.getSongCacheEntry(s.id);
                const album = cached?.album !== undefined ? cached.album : s.album;
                if (!album) return false;
                return albumIds.has(String(album.id ?? album.name));
            });
            if (albumFiltered.length > 0) customPool = albumFiltered;
        }

        function pickPool() {
            if (customPool) return customPool;
            const roll = Math.random();
            if (roll < 0.93 && albumPool.length) return albumPool;
            if (roll < 0.97 && features.length)  return features;
            if (singles.length)                  return singles;
            return albumPool.length ? albumPool : filtered;
        }

        let moreSongInfo = null;
        let song = null;
        const seen = new Set();
        for (let i = 0; i < 15; i++) {
            const pool = pickPool();
            if (!pool.length) break;
            const candidate = pool[Math.floor(Math.random() * pool.length)];
            if (seen.has(candidate.id)) continue;
            seen.add(candidate.id);
            const info = await genius.getSongById(candidate.id);
            if (info?.lyrics) { song = candidate; moreSongInfo = info; break; }
        }
        if (!moreSongInfo?.lyrics) return res.status(500).json({ error: "Could not find a song with lyrics" });

        const words = await genius.getWordArray(song.id);
        const response = {
            songId: song.id,
            title: song.title,
            wordCount: words.length,
            words: words,
            cover: moreSongInfo.cover || song.cover || null,
            artists: moreSongInfo.artists || song.artists || [],
            featured: moreSongInfo.featured || [],
        };
        // Hints are not sent in ranked mode — enforced server-side.
        if (!rankedSession) {
            response.hints = { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate };
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
        if (new Date(date) > new Date()) {
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

app.get("/api/albums", async (req, res) => {
    if (!otsochodziId) return res.status(503).json({ error: "Server is initializing" });
    if (cachedAlbums) return res.json(cachedAlbums);
    try {
        const allSongs = await genius.getAllSongs(otsochodziId);
        const albumMap = new Map();
        for (const s of allSongs) {
            const cached = genius.getSongCacheEntry(s.id);
            const album = cached?.album !== undefined ? cached.album : s.album;
            if (album?.name) {
                const key = String(album.id ?? album.name);
                if (!albumMap.has(key)) albumMap.set(key, { id: key, name: album.name });
            }
        }
        cachedAlbums = Array.from(albumMap.values()).sort((a, b) => a.name.localeCompare(b.name));
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
        const allSongs = await genius.getAllSongs(otsochodziId);
        if (!allSongs.length) return res.status(503).json({ error: "Song list unavailable" });
        const filtered = allSongs.filter(s => !SKIP_PATTERNS.test(s.title));

        const isPrimary = (s) => s.artists.some(a => String(a.id) === String(otsochodziId));
        const albumTracks = [], features = [], singles = [];
        for (const s of filtered) {
            const cached = genius.getSongCacheEntry(s.id);
            const album = cached?.album !== undefined ? cached.album : s.album;
            if (!isPrimary(s)) {
                features.push(s);
            } else if (album) {
                albumTracks.push(s);
            } else {
                singles.push(s);
            }
        }
        const albumPool = albumTracks;

        // Exclude songs already used this session
        function filterUsed(pool) {
            return pool.filter(s => !session.usedSongs.has(s.id));
        }
        function pickBucket() {
            const ap = filterUsed(albumPool);
            const fp = filterUsed(features);
            const sp = filterUsed(singles);
            const roll = Math.random();
            if (roll < 0.93 && ap.length) return ap;
            if (roll < 0.97 && fp.length) return fp;
            if (sp.length) return sp;
            return ap.length ? ap : filterUsed(filtered);
        }

        let moreSongInfo = null;
        let song = null;
        for (let i = 0; i < 15; i++) {
            const pool = pickBucket();
            if (!pool.length) break;
            song = pool[Math.floor(Math.random() * pool.length)];
            moreSongInfo = await genius.getSongById(song.id);
            if (moreSongInfo?.lyrics) break;
            moreSongInfo = null;
        }
        if (!moreSongInfo?.lyrics) return res.status(500).json({ error: "Could not find a song with lyrics" });

        session.pendingId = song.id;

        const words = await genius.getWordArray(song.id);
        res.json({
            songId: song.id,
            title: song.title,
            wordCount: words.length,
            words: words,
            cover: moreSongInfo.cover || song.cover || null,
            artists: moreSongInfo.artists || song.artists || [],
            featured: moreSongInfo.featured || [],
            hints: { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate }
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

app.get("/api/leaderboard", (req, res) => {
    try {
        res.setHeader("Cache-Control", "public, max-age=30");
        res.json(db.getLeaderboard(20));
    } catch (e) {
        res.status(500).json({ error: "Failed to read leaderboard" });
    }
});

// ── Leaderboard submit: requires a valid server-side session ──
app.post("/api/leaderboard", leaderboardLimiter, (req, res) => {
    const { name, sessionId } = req.body;
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

    const today = new Date().toISOString().split("T")[0];
    db.insertLeaderboard({ name: safeName, score, date: today });
    const board = db.getLeaderboard(200);
    const rank = board.findIndex(e => e.name === safeName && e.score === score && e.date === today) + 1;
    res.json({ rank });
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