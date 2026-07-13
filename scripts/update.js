#!/usr/bin/env node
/**
 * update.js — pre-deploy database migration & health check.
 *
 * Run this ONCE against the production database before starting the new server
 * build, e.g.:
 *
 *     node update.js                    # migrates db/app.db in place
 *     node update.js /path/to/app.db    # migrate a specific file
 *
 * It is idempotent: running it again on an already-migrated DB is a no-op.
 * It brings an old database schema up to date with everything the new
 * analytics code expects (per-user tracking + country-of-origin on plays),
 * backfills/dedupes where needed, and prints a before/after report so you can
 * confirm nothing was lost. The live server also self-migrates on boot, but
 * running this first lets you verify the result and catch problems early,
 * outside the request path.
 */

const path = require("path");
const fs   = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = process.argv[2] || path.join(__dirname, "..", "db", "app.db");

function log(msg)  { console.log(`[update] ${msg}`); }
function warn(msg) { console.warn(`[update] ⚠  ${msg}`); }

if (!fs.existsSync(DB_PATH)) {
  warn(`No database found at ${DB_PATH}.`);
  warn("Nothing to migrate — a fresh one will be created by the server on first boot.");
  process.exit(0);
}

log(`Opening ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const changes = [];
const hasColumn = (table, col) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
const tableExists = (table) =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
const count = (table) => {
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }
  catch { return 0; }
};

// ── 0. Snapshot BEFORE ────────────────────────────────────────
const before = {
  daily:       count("daily"),
  leaderboard: count("leaderboard"),
  daily_stats: count("daily_stats"),
  game_plays:  count("game_plays"),
};

db.transaction(() => {
  // ── 1. Ensure all tables exist (matches utils/db.js base schema) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily (
      date       TEXT PRIMARY KEY,
      song_id    INTEGER NOT NULL,
      word_index INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leaderboard (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT    NOT NULL,
      score   INTEGER NOT NULL,
      date    TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_stats (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      date    TEXT NOT NULL,
      outcome TEXT NOT NULL,
      words   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_plays (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      mode      TEXT NOT NULL,
      date      TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
  `);

  // ── 2. Add columns introduced by newer builds ──
  if (!hasColumn("leaderboard", "user_id")) {
    db.exec("ALTER TABLE leaderboard ADD COLUMN user_id TEXT;");
    changes.push("leaderboard.user_id column added");
  }
  if (!hasColumn("game_plays", "user_id")) {
    db.exec("ALTER TABLE game_plays ADD COLUMN user_id TEXT;");
    changes.push("game_plays.user_id column added");
  }
  if (!hasColumn("game_plays", "country")) {
    db.exec("ALTER TABLE game_plays ADD COLUMN country TEXT;");
    changes.push("game_plays.country column added");
  }

  // ── 3. Normalise existing country values (upper-case, 2 letters, else NULL) ──
  if (hasColumn("game_plays", "country")) {
    const fixed = db.prepare(`
      UPDATE game_plays
      SET country = CASE
        WHEN country IS NULL OR TRIM(country) = '' THEN NULL
        WHEN LENGTH(TRIM(country)) = 2 THEN UPPER(TRIM(country))
        ELSE UPPER(SUBSTR(TRIM(country), 1, 2))
      END
      WHERE country IS NOT NULL
        AND country <> UPPER(SUBSTR(TRIM(country), 1, 2))
    `).run();
    if (fixed.changes > 0) changes.push(`normalised ${fixed.changes} country value(s)`);
  }

  // ── 4. Indexes (safe to re-run) ──
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_daily_stats_date      ON daily_stats(date);
    CREATE INDEX IF NOT EXISTS idx_lb_score              ON leaderboard(score DESC);
    CREATE INDEX IF NOT EXISTS idx_lb_user_id            ON leaderboard(user_id);
    CREATE INDEX IF NOT EXISTS idx_game_plays_mode_date  ON game_plays(mode, date);
    CREATE INDEX IF NOT EXISTS idx_game_plays_user_id    ON game_plays(user_id);
    CREATE INDEX IF NOT EXISTS idx_game_plays_country    ON game_plays(country);
  `);

  // ── 5. Deduplicate leaderboard: keep highest score per name (case-insensitive) ──
  const dupes = db.prepare(`
    SELECT LOWER(name) AS lname, COUNT(*) AS cnt
    FROM leaderboard GROUP BY LOWER(name) HAVING cnt > 1
  `).all();
  if (dupes.length) {
    let removed = 0;
    for (const dup of dupes) {
      const rows = db.prepare(
        "SELECT id FROM leaderboard WHERE LOWER(name) = ? ORDER BY score DESC, date DESC"
      ).all(dup.lname);
      const keepId = rows[0].id;
      const r = db.prepare("DELETE FROM leaderboard WHERE LOWER(name) = ? AND id != ?").run(dup.lname, keepId);
      removed += r.changes;
    }
    if (removed) changes.push(`removed ${removed} duplicate leaderboard row(s)`);
  }
})();

// ── 6. Migrate legacy JSON files if the tables are still empty ──
const DB_DIR = path.dirname(DB_PATH);
const legacy = {
  daily:       path.join(DB_DIR, "daily.json"),
  leaderboard: path.join(DB_DIR, "leaderboard.json"),
  stats:       path.join(DB_DIR, "daily-stats.json"),
};

if (count("daily") === 0 && fs.existsSync(legacy.daily)) {
  try {
    const rows = JSON.parse(fs.readFileSync(legacy.daily, "utf8"));
    const stmt = db.prepare("INSERT OR IGNORE INTO daily (date, song_id, word_index) VALUES (?, ?, ?)");
    db.transaction(() => rows.forEach(r => stmt.run(r.date, r.songID, r.wordIndex)))();
    changes.push(`imported ${rows.length} daily rows from daily.json`);
  } catch (e) { warn(`daily.json import failed: ${e.message}`); }
}
if (count("leaderboard") === 0 && fs.existsSync(legacy.leaderboard)) {
  try {
    const rows = JSON.parse(fs.readFileSync(legacy.leaderboard, "utf8"));
    const stmt = db.prepare("INSERT INTO leaderboard (name, score, date, user_id) VALUES (?, ?, ?, NULL)");
    db.transaction(() => rows.forEach(r => stmt.run(r.name, r.score, r.date)))();
    changes.push(`imported ${rows.length} leaderboard rows from leaderboard.json`);
  } catch (e) { warn(`leaderboard.json import failed: ${e.message}`); }
}
if (count("daily_stats") === 0 && fs.existsSync(legacy.stats)) {
  try {
    const data = JSON.parse(fs.readFileSync(legacy.stats, "utf8"));
    const stmt = db.prepare("INSERT INTO daily_stats (date, outcome, words) VALUES (?, ?, ?)");
    db.transaction(() => {
      for (const [date, day] of Object.entries(data)) {
        for (const w of (day.correct || [])) stmt.run(date, "correct", w);
        for (const w of (day.giveup  || [])) stmt.run(date, "giveup",  w);
      }
    })();
    changes.push("imported daily_stats from daily-stats.json");
  } catch (e) { warn(`daily-stats.json import failed: ${e.message}`); }
}

// ── 7. Integrity check ──
const integrity = db.prepare("PRAGMA integrity_check").get();
const integrityOk = integrity && integrity.integrity_check === "ok";

// ── 8. Report ──
const after = {
  daily:       count("daily"),
  leaderboard: count("leaderboard"),
  daily_stats: count("daily_stats"),
  game_plays:  count("game_plays"),
};

console.log("\n──────────── migration report ────────────");
console.log("table         before →  after");
for (const t of Object.keys(before)) {
  console.log(`  ${t.padEnd(12)} ${String(before[t]).padStart(6)} → ${String(after[t]).padStart(6)}`);
}
console.log("\nschema changes:");
if (changes.length) changes.forEach(c => console.log(`  • ${c}`));
else console.log("  • none — database already up to date");

// Quick country coverage snapshot (helps confirm geo headers are flowing)
if (tableExists("game_plays") && hasColumn("game_plays", "country")) {
  const withCountry = db.prepare("SELECT COUNT(*) AS n FROM game_plays WHERE country IS NOT NULL").get().n;
  console.log(`\ngeo coverage: ${withCountry}/${after.game_plays} plays have a country tag`);
}

console.log(`\nintegrity check: ${integrityOk ? "ok ✅" : "FAILED ❌ — " + JSON.stringify(integrity)}`);
console.log("──────────────────────────────────────────\n");

db.close();

if (!integrityOk) {
  warn("Integrity check did not return 'ok'. Do NOT deploy until resolved.");
  process.exit(1);
}
log("Database is ready for production. ✅");
