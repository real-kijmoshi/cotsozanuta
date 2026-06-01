/**
 * migrate.js — one-shot database migration runner
 *
 * Run with:  node migrate.js
 *
 * Safe to run multiple times (all operations are idempotent).
 */

"use strict";

const Database = require("better-sqlite3");
const path     = require("path");
const fs       = require("fs");

const DB_DIR = path.join(__dirname, "db");
const DB_PATH = path.join(DB_DIR, "app.db");

if (!fs.existsSync(DB_PATH)) {
  console.error(`[migrate] Database not found at ${DB_PATH}`);
  console.error("[migrate] Start the app at least once to create the database, then re-run this script.");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

let changes = 0;

// ── 1. Add user_id column if missing ──────────────────────────────────────────
const cols = db.prepare("PRAGMA table_info(leaderboard)").all();
if (!cols.some(c => c.name === "user_id")) {
  db.exec("ALTER TABLE leaderboard ADD COLUMN user_id TEXT;");
  console.log("[migrate] ✓ Added user_id column to leaderboard.");
  changes++;
} else {
  console.log("[migrate] — user_id column already present.");
}

// ── 2. Create index on user_id ────────────────────────────────────────────────
db.exec("CREATE INDEX IF NOT EXISTS idx_lb_user_id ON leaderboard(user_id);");
console.log("[migrate] ✓ Index idx_lb_user_id ensured.");

// ── 3. Deduplicate leaderboard by name (keep highest score per lowercase name) ─
const dupes = db.prepare(`
  SELECT LOWER(name) AS lname, COUNT(*) AS cnt
  FROM leaderboard
  GROUP BY LOWER(name)
  HAVING cnt > 1
`).all();

if (dupes.length > 0) {
  console.log(`[migrate] Found ${dupes.length} duplicate name(s) — deduplicating...`);
  db.transaction(() => {
    for (const dup of dupes) {
      const rows = db.prepare(`
        SELECT id, score FROM leaderboard
        WHERE LOWER(name) = ?
        ORDER BY score DESC, date DESC
      `).all(dup.lname);
      const keepId = rows[0].id;
      db.prepare("DELETE FROM leaderboard WHERE LOWER(name) = ? AND id != ?")
        .run(dup.lname, keepId);
    }
  })();
  console.log("[migrate] ✓ Duplicates removed.");
  changes++;
} else {
  console.log("[migrate] — No duplicate leaderboard entries found.");
}

// ── 4. Ensure base tables / indices exist (idempotent) ───────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS game_plays (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    mode      TEXT NOT NULL,
    date      TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_daily_stats_date     ON daily_stats(date);
  CREATE INDEX IF NOT EXISTS idx_lb_score             ON leaderboard(score DESC);
  CREATE INDEX IF NOT EXISTS idx_game_plays_mode_date ON game_plays(mode, date);
`);
console.log("[migrate] ✓ Base indices ensured.");

// ── 5. Add user_id column to game_plays if missing ───────────────────────────
const gpCols = db.prepare("PRAGMA table_info(game_plays)").all();
if (!gpCols.some(c => c.name === "user_id")) {
  db.exec("ALTER TABLE game_plays ADD COLUMN user_id TEXT;");
  console.log("[migrate] ✓ Added user_id column to game_plays.");
  changes++;
} else {
  console.log("[migrate] — user_id column already present in game_plays.");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_game_plays_user_id ON game_plays(user_id);");
console.log("[migrate] ✓ Index idx_game_plays_user_id ensured.");

db.close();
console.log(`\n[migrate] Done. ${changes} change(s) applied.`);
