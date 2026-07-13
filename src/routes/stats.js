const express = require("express");
const db = require("../../utils/db");
const { statsLimiter } = require("../rateLimiters");

const router = express.Router();

router.get("/:date", (req, res) => {
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

router.post("/:date", statsLimiter, (req, res) => {
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

module.exports = router;
