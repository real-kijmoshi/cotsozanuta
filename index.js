// Requiring ./src/config first loads .env before any module reads process.env.
const { PORT, isProd, PUBLIC_DIR, VIEWS_DIR } = require("./src/config");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");

const log = require("./utils/logger")("server");
const genius = require("./utils/genius");
const db = require("./utils/db");
const { startSessionCleanup } = require("./src/rankedSessions");
const { runWarmup } = require("./src/warmup");
const { createWarmupServer } = require("./src/warmupServer");

const pagesRouter       = require("./src/routes/pages");
const adminRouter       = require("./src/routes/admin");
const gameRouter        = require("./src/routes/game");
const contentRouter     = require("./src/routes/content");
const statsRouter       = require("./src/routes/stats");
const rankedRouter      = require("./src/routes/ranked");
const leaderboardRouter = require("./src/routes/leaderboard");
const audioRouter       = require("./src/routes/audio");

function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  // ── Request ID ────────────────────────────────────────────
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  app.use(compression());
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:    ["'self'"],
        scriptSrc:     ["'self'", "'unsafe-inline'"],  // static HTML pages use inline <script>
        styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc:       ["'self'", "https://fonts.gstatic.com"],
        imgSrc:        ["'self'", "data:", "https:"],
        connectSrc:    ["'self'"],
        frameSrc:      ["'none'"],
        objectSrc:     ["'none'"],
        baseUri:       ["'self'"],
        formAction:    ["'self'"],
        frameAncestors:["'none'"],
        upgradeInsecureRequests: isProd ? [] : null,
      },
    },
  }));
  app.use(express.json({ limit: "100kb" }));

  // ── CSRF: validate Origin/Referer on state-changing requests ──
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin || req.headers.referer;
    if (origin) {
      try {
        const u = new URL(origin);
        const host = req.headers.host || '';
        if (u.host !== host && !host.endsWith('.' + u.host) && !u.host.endsWith('.' + host)) {
          return res.status(403).json({ error: 'CSRF rejected' });
        }
      } catch { /* malformed origin — allow */ }
    }
    next();
  });

  app.use("/images", express.static(path.join(PUBLIC_DIR, "images"), { maxAge: "7d", etag: true, lastModified: true }));
  app.use(express.static(PUBLIC_DIR, { etag: true, lastModified: true }));

  // ── Health check ────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    try {
      db.ping();
      res.json({ status: "ok", db: "ok", uptime: process.uptime() | 0 });
    } catch {
      res.status(503).json({ status: "error", db: "error" });
    }
  });

  app.use("/", pagesRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/game", gameRouter);
  app.use("/api/daily-stats", statsRouter);
  app.use("/api/ranked", rankedRouter);
  app.use("/api/leaderboard", leaderboardRouter);
  app.use("/api", contentRouter);
  app.use("/api/audio", audioRouter);

  app.use((req, res) => { res.status(404).sendFile("404.html", { root: VIEWS_DIR }); });

  // ── Global error handler ────────────────────────────────────
  app.use((err, req, res, _next) => {
    log.error("unhandled route error", { path: req.path, err: err.message });
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

async function boot() {
  // ── Phase 1: start warmup server ──────────────────────────────
  const { server: warmupSrv, broadcast } = createWarmupServer();
  warmupSrv.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log.error(`Port ${PORT} in use — old process still running? Killing...`);
      process.exit(1);
    }
  });
  await new Promise((resolve, reject) => {
    warmupSrv.listen(PORT, () => {
      log.info(`Warmup server on port ${PORT}`);
      resolve();
    });
    warmupSrv.once('error', reject);
  });

  // ── Phase 2: run warmup ───────────────────────────────────────
  const ok = await runWarmup(broadcast);

  // ── Phase 3: let clients receive the "ready" event ────────────
  // broadcast() writes to SSE buffers, but closeAllConnections() would
  // destroy the sockets before the data reaches the client.  Wait a
  // moment so the browser gets the "ready" event and starts polling,
  // THEN tear down the warmup server (the client detects the teardown
  // via a failed fetch and reloads into the real server).
  await new Promise(r => setTimeout(r, 500));

  // ── Phase 4: force-kill warmup server ─────────────────────────
  await new Promise((resolve) => {
    warmupSrv.closeAllConnections?.();
    warmupSrv.close(() => resolve());
    setTimeout(resolve, 2000).unref();
  });
  log.info("Warmup server closed");

  if (!ok) {
    log.error("Warmup failed, exiting");
    process.exit(1);
  }

  // ── Phase 4: start real server on same port ───────────────────
  startSessionCleanup();
  const app = createApp();
  const server = app.listen(PORT, () => {
    log.info(`Server is running on port ${PORT}`);
  });

  function shutdown(signal) {
    log.info(`${signal} received — shutting down gracefully`);
    genius.flushSongCache();
    server.close(() => { log.info("HTTP server closed"); process.exit(0); });
    setTimeout(() => { log.error("Forced exit"); process.exit(1); }, 10_000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => { log.error("uncaughtException:", err); shutdown("uncaughtException"); });
  process.on("unhandledRejection", (r) => { log.error("unhandledRejection:", r); shutdown("unhandledRejection"); });
}

boot().catch((err) => {
  log.error("boot failed:", err);
  process.exit(1);
});
