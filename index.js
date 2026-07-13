// Requiring ./src/config first loads .env before any module reads process.env.
const { PORT, isProd, PUBLIC_DIR, VIEWS_DIR } = require("./src/config");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");

const genius = require("./utils/genius");
const { startSessionCleanup } = require("./src/rankedSessions");
const { runWarmup } = require("./src/warmup");

const pagesRouter       = require("./src/routes/pages");
const adminRouter       = require("./src/routes/admin");
const gameRouter        = require("./src/routes/game");
const contentRouter     = require("./src/routes/content");
const statsRouter       = require("./src/routes/stats");
const rankedRouter      = require("./src/routes/ranked");
const leaderboardRouter = require("./src/routes/leaderboard");

const app = express();
app.set('trust proxy', 1);

// Gzip/deflate all text responses (HTML, JSON, etc.)
app.use(compression());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "https://www.youtube.com"], // inline scripts + YouTube IFrame API
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      imgSrc:      ["'self'", "data:", "https:"],   // album art from any Genius CDN
      connectSrc:  ["'self'", "https://www.youtube.com"],
      frameSrc:    ["https://www.youtube.com", "https://www.youtube-nocookie.com"], // hidden YouTube player (audio mode)
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
      // Helmet enables `upgrade-insecure-requests` by default, which rewrites the
      // page's own http:// fetches to https://. Over plain-HTTP localhost that
      // makes every /api call fail with an SSL/CORS error. Keep it only in prod.
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
}));
app.use(express.json({ limit: "16kb" }));

// Serve static files; images get a 7-day cache, ETag enables conditional GETs.
app.use("/images", express.static(path.join(PUBLIC_DIR, "images"), {
    maxAge: "7d",
    etag: true,
    lastModified: true,
}));
app.use(express.static(PUBLIC_DIR, { etag: true, lastModified: true }));

// ── Routes ───────────────────────────────────────────────────
app.use("/", pagesRouter);
app.use("/api/admin", adminRouter);
app.use("/api/game", gameRouter);
app.use("/api/daily-stats", statsRouter);
app.use("/api/ranked", rankedRouter);
app.use("/api/leaderboard", leaderboardRouter);
app.use("/api", contentRouter); // /api/lyrics, /api/autocomplete/songs, /api/discography, /api/albums

// ── 404 catch-all ───────────────────────────────────────────
app.use((req, res) => {
    res.status(404).sendFile("404.html", { root: VIEWS_DIR });
});

// ── Startup ──────────────────────────────────────────────────
startSessionCleanup();
runWarmup();

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
