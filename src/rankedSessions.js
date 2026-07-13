// ── Ranked session store ─────────────────────────────────────
// Sessions expire after inactivity, cleaned up every 5 minutes.
const RANKED_GRACE_MS = 3_000; // tiny grace for network latency
const MAX_SESSIONS = 10_000;

// Each ranked sub-mode has its own leaderboard (see utils/db.js RANKED_MODES).
//   sprint60/sprint180 — a fixed total window; score = songs guessed.
//   survival          — no total window; each song has its own time limit and a
//                        late/missed guess ends the run. score = streak length.
// maxScore is a hard anti-cheat ceiling (comfortably above realistic play).
const RANKED_MODES = {
    sprint60:  { kind: "sprint",   durationMs: 60_000,  maxScore: 40  },
    sprint180: { kind: "sprint",   durationMs: 180_000, maxScore: 120 },
    survival:  { kind: "survival", perSongMs:  30_000,  maxScore: 300 },
};
const DEFAULT_RANKED_MODE = "sprint60";

function rankedModeConfig(mode) { return RANKED_MODES[mode] || RANKED_MODES[DEFAULT_RANKED_MODE]; }

// sessionId → session object.
const rankedSessions = new Map();

function isAtCapacity() {
    return rankedSessions.size >= MAX_SESSIONS;
}

// True when the time available to answer the CURRENT pending song has run out.
//   sprint*  — the whole-run window elapsed.
//   survival — the per-song window elapsed (only once a song is pending).
function rankedTimeExpired(session) {
    const cfg = rankedModeConfig(session.mode);
    if (cfg.kind === "survival") {
        if (session.issuedAt == null) return false;
        return Date.now() - session.issuedAt > cfg.perSongMs + RANKED_GRACE_MS;
    }
    return Date.now() - session.startedAt > cfg.durationMs + RANKED_GRACE_MS;
}

// Periodically evict idle sessions. Sprints finish within their window; survival
// can run long, so expire on inactivity (last song fetch / guess) rather than
// start time. Call once at startup.
function startSessionCleanup() {
    setInterval(() => {
        const cutoff = Date.now() - 15 * 60_000;
        for (const [id, s] of rankedSessions) {
            if ((s.lastActivity || s.startedAt) < cutoff) rankedSessions.delete(id);
        }
    }, 5 * 60_000).unref();
}

module.exports = {
    RANKED_MODES,
    DEFAULT_RANKED_MODE,
    rankedSessions,
    rankedModeConfig,
    rankedTimeExpired,
    startSessionCleanup,
    isAtCapacity,
    MAX_SESSIONS,
};
