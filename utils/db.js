const Database = require("better-sqlite3");
const fs   = require("fs");
const path = require("path");

const DB_DIR  = path.join(__dirname, "../db");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, "app.db"));

// WAL gives better read/write concurrency and crash safety
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS daily (
    date       TEXT PRIMARY KEY,
    song_id    INTEGER NOT NULL,
    word_index INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leaderboard (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL,
    score INTEGER NOT NULL,
    date  TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    date    TEXT NOT NULL,
    outcome TEXT NOT NULL,
    words   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
  CREATE INDEX IF NOT EXISTS idx_lb_score         ON leaderboard(score DESC);
`);

// ── One-time migration from legacy JSON files ────────────────
(function migrate() {
  const legacyPaths = {
    daily:       path.join(DB_DIR, "daily.json"),
    leaderboard: path.join(DB_DIR, "leaderboard.json"),
    stats:       path.join(DB_DIR, "daily-stats.json"),
  };

  if (db.prepare("SELECT COUNT(*) AS n FROM daily").get().n === 0 &&
      fs.existsSync(legacyPaths.daily)) {
    try {
      const rows = JSON.parse(fs.readFileSync(legacyPaths.daily, "utf8"));
      const stmt = db.prepare("INSERT OR IGNORE INTO daily (date, song_id, word_index) VALUES (?, ?, ?)");
      db.transaction(() => rows.forEach(r => stmt.run(r.date, r.songID, r.wordIndex)))();
      console.log(`[DB] Migrated ${rows.length} daily entries from JSON`);
    } catch (e) { console.error("[DB] daily.json migration failed:", e.message); }
  }

  if (db.prepare("SELECT COUNT(*) AS n FROM leaderboard").get().n === 0 &&
      fs.existsSync(legacyPaths.leaderboard)) {
    try {
      const rows = JSON.parse(fs.readFileSync(legacyPaths.leaderboard, "utf8"));
      const stmt = db.prepare("INSERT INTO leaderboard (name, score, date) VALUES (?, ?, ?)");
      db.transaction(() => rows.forEach(r => stmt.run(r.name, r.score, r.date)))();
      console.log(`[DB] Migrated ${rows.length} leaderboard entries from JSON`);
    } catch (e) { console.error("[DB] leaderboard.json migration failed:", e.message); }
  }

  if (db.prepare("SELECT COUNT(*) AS n FROM daily_stats").get().n === 0 &&
      fs.existsSync(legacyPaths.stats)) {
    try {
      const data = JSON.parse(fs.readFileSync(legacyPaths.stats, "utf8"));
      const stmt = db.prepare("INSERT INTO daily_stats (date, outcome, words) VALUES (?, ?, ?)");
      db.transaction(() => {
        for (const [date, day] of Object.entries(data)) {
          for (const w of (day.correct || [])) stmt.run(date, "correct", w);
          for (const w of (day.giveup  || [])) stmt.run(date, "giveup",  w);
        }
      })();
      console.log("[DB] Migrated daily_stats from JSON");
    } catch (e) { console.error("[DB] daily-stats.json migration failed:", e.message); }
  }
})();

// ── Prepared statements ──────────────────────────────────────
const stmts = {
  getAllDaily:     db.prepare("SELECT date, song_id AS songID, word_index AS wordIndex FROM daily ORDER BY date"),
  getDailyByDate:  db.prepare("SELECT date, song_id AS songID, word_index AS wordIndex FROM daily WHERE date = ?"),
  upsertDaily:     db.prepare("INSERT OR REPLACE INTO daily (date, song_id, word_index) VALUES (?, ?, ?)"),
  deleteDaily:     db.prepare("DELETE FROM daily WHERE date = ?"),

  getTopLb:        db.prepare("SELECT name, score, date FROM leaderboard ORDER BY score DESC LIMIT ?"),
  insertLb:        db.prepare("INSERT INTO leaderboard (name, score, date) VALUES (?, ?, ?)"),
  trimLb:          db.prepare("DELETE FROM leaderboard WHERE id NOT IN (SELECT id FROM leaderboard ORDER BY score DESC LIMIT 200)"),

  getStatsByDate:  db.prepare("SELECT outcome, words FROM daily_stats WHERE date = ?"),
  addStat:         db.prepare("INSERT INTO daily_stats (date, outcome, words) VALUES (?, ?, ?)"),
  getAllStats:      db.prepare("SELECT date, outcome, words FROM daily_stats ORDER BY date"),
};

module.exports = {
  // ── Daily ────────────────────────────────────────────────────
  getDaily()            { return stmts.getAllDaily.all(); },
  getDailyByDate(date)  { return stmts.getDailyByDate.get(date) || null; },
  upsertDaily({ date, songID, wordIndex }) { stmts.upsertDaily.run(date, songID, wordIndex); },
  deleteDaily(date)     { stmts.deleteDaily.run(date); },

  // ── Leaderboard ──────────────────────────────────────────────
  getLeaderboard(n = 200) { return stmts.getTopLb.all(n); },
  insertLeaderboard({ name, score, date }) {
    stmts.insertLb.run(name, score, date);
    stmts.trimLb.run();
  },

  // ── Stats ────────────────────────────────────────────────────
  getStatsByDate(date) {
    const result = { correct: [], giveup: [] };
    for (const r of stmts.getStatsByDate.all(date)) result[r.outcome].push(r.words);
    return result;
  },
  addStat(date, outcome, words) { stmts.addStat.run(date, outcome, words); },
  getAllStats() {
    const result = {};
    for (const r of stmts.getAllStats.all()) {
      if (!result[r.date]) result[r.date] = { correct: [], giveup: [] };
      result[r.date][r.outcome].push(r.words);
    }
    return result;
  },
};
