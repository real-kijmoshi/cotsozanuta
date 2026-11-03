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
        const { song } = picked;
        session.pendingId = song.id;
        session.issuedAt  = Date.now();
        session.lastActivity = session.issuedAt;
        session.wrongGuesses = 0;

        // The answer (id / title / cover / artists) is never sent to the client;
        // guesses are verified server-side in POST /correct.
        const words = await genius.getWordArray(song.id);
        res.json({ wordCount: words.length, words });
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

// ── Ranked: submit a guess ───────────────────────────────────
// The client sends the id of the song it THINKS is playing (picked from the
// autocomplete). The server compares it with the song it issued to this
// session — the client never learns the answer up front, so it can't simply
// echo it back. Wrong guesses per song are capped to stop brute-forcing the
// catalogue by submitting every id.
const MAX_WRONG_GUESSES = 8;

router.post("/correct", rankedCorrectLimiter, (req, res) => {
    const { sessionId } = req.body || {};
    const guess = req.body?.guessId ?? req.body?.songId;
    if (!sessionId || guess == null) return res.status(400).json({ error: "Missing fields" });

    const session = rankedSessions.get(String(sessionId));
    if (!session)          return res.status(404).json({ error: "Session not found" });
    if (session.finished)  return res.status(400).json({ error: "Session already finished" });

    const cfg = rankedModeConfig(session.mode);
    if (rankedTimeExpired(session)) {
        // Survival: a late guess ends the run outright.
        session.finished = true;
        return res.status(400).json({ error: "Session expired", expired: true, score: session.score });
    }

    const guessInt = parseInt(guess, 10);
    if (!Number.isInteger(guessInt) || guessInt <= 0)
        return res.status(400).json({ error: "Invalid songId" });

    if (session.pendingId === null)
        return res.status(400).json({ error: "No pending song for this session" });

    session.lastActivity = Date.now();

    if (guessInt !== session.pendingId) {
        session.wrongGuesses = (session.wrongGuesses || 0) + 1;
        const attemptsLeft = Math.max(0, MAX_WRONG_GUESSES - session.wrongGuesses);
        if (attemptsLeft === 0) {
            // Out of attempts: burn the song. The client has to fetch the next one.
            session.pendingId = null;
            session.issuedAt  = null;
        }
        return res.json({ correct: false, attemptsLeft, score: session.score });
    }

    if (session.score >= cfg.maxScore)
        return res.status(400).json({ error: "Score ceiling reached" });

    session.usedSongs.add(guessInt);
    session.pendingId = null;   // consumed — client must fetch the next song
    session.issuedAt  = null;   // survival: stop the per-song clock until the next song is issued
    session.score++;
    res.json({ correct: true, score: session.score });
});

module.exports = router;
