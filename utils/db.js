const fs = require("fs");
const path = require("path");

const DB_DIR = path.join(__dirname, "../db");

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const PATHS = {
  daily:       path.join(DB_DIR, "daily.json"),
  leaderboard: path.join(DB_DIR, "leaderboard.json"),
  stats:       path.join(DB_DIR, "daily-stats.json"),
};

const store = { daily: null, leaderboard: null, stats: null };

function load(key, fallback) {
  if (!fs.existsSync(PATHS[key])) { store[key] = fallback; return; }
  try { store[key] = JSON.parse(fs.readFileSync(PATHS[key], "utf8")); }
  catch { store[key] = fallback; }
}

// Atomic write: write to a temp file then rename to avoid corruption on crash
function save(key) {
  const dest = PATHS[key];
  const tmp  = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store[key], null, 2));
  fs.renameSync(tmp, dest);
}

load("daily",       []);
load("leaderboard", []);
load("stats",       {});

module.exports = {
  // Return deep copies so callers can't accidentally mutate the store
  getDaily:              () => JSON.parse(JSON.stringify(store.daily)),
  writeDaily(data)       { store.daily = data; save("daily"); },

  getLeaderboard:        () => JSON.parse(JSON.stringify(store.leaderboard)),
  writeLeaderboard(data) { store.leaderboard = data; save("leaderboard"); },

  getStats:              () => JSON.parse(JSON.stringify(store.stats)),
  writeStats(data)       { store.stats = data; save("stats"); },
};
