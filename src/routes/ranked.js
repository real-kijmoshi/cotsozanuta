const express = require("express");
const crypto = require("crypto");
const genius = require("../../utils/genius");
const db = require("../../utils/db");
const state = require("../state");
const { pickSong } = require("../songPicker");
const { getCountry } = require("../geo");
const {
    RANKED_MODES,
    DEFAULT_RANKED_MODE,
    rankedSessions,
    rankedModeConfig,
    rankedTimeExpired,
    isAtCapacity,
} = require("../rankedSessions");
const { rankedSongLimiter, rankedStartLimiter, rankedCorrectLimiter } = require("../rateLimiters");

const router = express.Router();

// ── Ranked: get next song ───────────────────────────────────
// Self-contained replacement for /api/game/endless in ranked mode.
// Picks a song, registers it as pendingId on the session, and returns the
// same payload shape so the frontend needs no other endpoint for ranked play.
router.get("/song", rankedSongLimiter, async (req, res) => {
    if (!state.otsochodziId) return res.status(503).json({ error: "Server is initializing, try again shortly" });

    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    const session = rankedSessions.get(String(sessionId));
    if (!session)          return res.status(404).json({ error: "Session not found" });
    if (session.finished)  return res.status(400).json({ error: "Session already finished" });

    if (rankedTimeExpired(session)) {
        session.finished = true;
        return res.status(400).json({ error: "Session expired" });
    }

    try {
        const picked = await pickSong(state.otsochodziId, { usedSongs: session.usedSongs });
        if (!picked) return res.status(500).json({ error: "Could not find a song with lyrics" });
        const { song, moreSongInfo } = picked;
        session.pendingId = song.id;
        session.issuedAt  = Date.now();
        session.lastActivity = session.issuedAt;

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
router.post("/start", rankedStartLimiter, (req, res) => {
    if (isAtCapacity()) return res.status(503).json({ error: "Server is at session capacity, try again shortly" });
    const mode = RANKED_MODES[req.body?.mode] ? req.body.mode : DEFAULT_RANKED_MODE;
    const gameType = db.normalizeGameType(req.body?.gameType);
    const cfg  = rankedModeConfig(mode);
    const sessionId = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    rankedSessions.set(sessionId, {
        mode,
        gameType,
        startedAt:  now,
        lastActivity: now,
        issuedAt:   null,
        score:      0,
        usedSongs:  new Set(),
        pendingId:  null,
        finished:   false,
        submitted:  false,
    });
    // Log ranked game play (all sub-modes log as "ranked" — keeps analytics stable).
    const rankedUid = req.body?.userId ? String(req.body.userId).trim().slice(0, 128)
        : (req.headers['x-user-id'] ? String(req.headers['x-user-id']).trim().slice(0, 128) : null);
    db.logGamePlay("ranked", rankedUid, null, getCountry(req));
    res.json({ sessionId, mode, durationMs: cfg.durationMs || null, perSongMs: cfg.perSongMs || null, maxScore: cfg.maxScore });
});

// ── Ranked: record a correct guess ───────────────────────────
// Only accepts the exact songId the server issued via /api/game/endless for
// this session. Arbitrary catalog IDs (from a pre-built list, etc.) are
// rejected — blocking automated-script attacks.
router.post("/correct", rankedCorrectLimiter, (req, res) => {
    const { sessionId, songId } = req.body;
    if (!sessionId || !songId) return res.status(400).json({ error: "Missing fields" });

    const session = rankedSessions.get(String(sessionId));
    if (!session)          return res.status(404).json({ error: "Session not found" });
    if (session.finished)  return res.status(400).json({ error: "Session already finished" });

    const cfg = rankedModeConfig(session.mode);
    if (rankedTimeExpired(session)) {
        // Survival: a late guess ends the run outright.
        session.finished = true;
        return res.status(400).json({ error: "Session expired", expired: true, score: session.score });
    }

    const songIdInt = parseInt(songId, 10);
    if (!Number.isInteger(songIdInt) || songIdInt <= 0)
        return res.status(400).json({ error: "Invalid songId" });

    // Core defence: must match the song the server issued to this session.
    if (session.pendingId === null)
        return res.status(400).json({ error: "No pending song for this session" });
    if (songIdInt !== session.pendingId)
        return res.status(400).json({ error: "Song not issued to this session" });

    if (session.score >= cfg.maxScore)
        return res.status(400).json({ error: "Score ceiling reached" });

    session.usedSongs.add(songIdInt);
    session.pendingId = null;   // consumed — client must fetch next song via /api/game/endless
    session.issuedAt  = null;   // survival: stop the per-song clock until the next song is issued
    session.lastActivity = Date.now();
    session.score++;
    res.json({ score: session.score });
});

module.exports = router;
