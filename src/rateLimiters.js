const { rateLimit } = require("express-rate-limit");

// Per-endpoint rate limiters. Windows/maxes tuned per route sensitivity.
module.exports = {
    loginLimiter:         rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }),
    statsLimiter:         rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }),
    leaderboardLimiter:   rateLimit({ windowMs: 60 * 1000, max: 3,  standardHeaders: true, legacyHeaders: false }),
    lyricsLimiter:        rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }),
    rankedStartLimiter:   rateLimit({ windowMs: 60 * 1000, max: 5,  standardHeaders: true, legacyHeaders: false }),
    rankedCorrectLimiter: rateLimit({ windowMs: 60 * 1000, max: 80, standardHeaders: true, legacyHeaders: false }),
    rankedSongLimiter:    rateLimit({ windowMs: 60 * 1000, max: 80, standardHeaders: true, legacyHeaders: false }),
};
