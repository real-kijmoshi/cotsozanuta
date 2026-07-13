const express = require("express");
const db = require("../../utils/db");
const { rankedSessions, rankedModeConfig } = require("../rankedSessions");
const { leaderboardLimiter, leaderboardGetLimiter } = require("../rateLimiters");

const router = express.Router();

router.get("/monthly", leaderboardGetLimiter, (req, res) => {
    try {
        res.setHeader("Cache-Control", "public, max-age=300");
        const mode = db.normalizeMode(req.query.mode);
        const gameType = db.normalizeGameType(req.query.gameType);
        const data = db.getRankedByMonth(mode, gameType);
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

router.get("/", leaderboardGetLimiter, (req, res) => {
    try {
        const mode = db.normalizeMode(req.query.mode);
        const gameType = db.normalizeGameType(req.query.gameType);
        const limitParam = parseInt(req.query.limit, 10);
        const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 20;
        res.setHeader("Cache-Control", "public, max-age=30");
        res.json(db.getLeaderboard(mode, gameType, limit));
    } catch (e) {
        res.status(500).json({ error: "Failed to read leaderboard" });
    }
});

// ── Leaderboard submit: requires a valid server-side session ──
router.post("/", leaderboardLimiter, (req, res) => {
    const { name, sessionId, userId } = req.body;
    if (!name || !sessionId) return res.status(400).json({ error: "Missing name or sessionId" });

    const session = rankedSessions.get(String(sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });

    const cfg = rankedModeConfig(session.mode);
    // Game must be over. Sprints: the fixed window must have (near) elapsed, or
    // the session was already flagged finished. Survival: the score is fully
    // server-authoritative and there's no early-submit advantage, so a submit
    // simply finalizes the run.
    if (cfg.kind === "sprint") {
        const elapsed = Date.now() - session.startedAt;
        if (elapsed < cfg.durationMs - 2000 && !session.finished)
            return res.status(400).json({ error: "Game not finished yet" });
    }

    // Single-use token: prevent re-submitting the same session
    if (session.submitted) return res.status(400).json({ error: "Score already submitted" });
    session.submitted = true;
    session.finished  = true;

    const score    = session.score;
    const safeName = String(name).replace(/[<>&"'`]/g, "").trim().slice(0, 32);
    if (!safeName) return res.status(400).json({ error: "Invalid name" });

    const safeUserId = userId ? String(userId).trim().slice(0, 128) : null;
    const today = new Date().toISOString().split("T")[0];
    const rank = db.insertLeaderboard({ name: safeName, score, date: today, user_id: safeUserId, mode: session.mode, game_type: session.gameType || 'tekst' });
    res.json({ rank: rank || 0, mode: session.mode, gameType: session.gameType || 'tekst', score });
});

module.exports = router;
