const Database = require("better-sqlite3");
const fs   = require("fs");
const path = require("path");

const DB_DIR  = path.join(__dirname, "../db");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, "app.db"));

// WAL gives better read/write concurrency and crash safety
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Base schema (no user_id index yet – added after migration below) ─
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

  CREATE INDEX IF NOT EXISTS idx_daily_stats_date     ON daily_stats(date);
  CREATE INDEX IF NOT EXISTS idx_lb_score             ON leaderboard(score DESC);
  CREATE INDEX IF NOT EXISTS idx_game_plays_mode_date ON game_plays(mode, date);
`);

// ── Migrate: add user_id column to existing leaderboard and game_plays tables ──
(function migrateUserIdColumn() {
  // leaderboard
  const cols = db.prepare("PRAGMA table_info(leaderboard)").all();
  if (!cols.some(c => c.name === "user_id")) {
    try {
      db.exec("ALTER TABLE leaderboard ADD COLUMN user_id TEXT;");
      console.log("[DB] Added user_id column to leaderboard.");
    } catch (err) {
      console.error("[DB] Failed to add user_id column:", err.message);
    }
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_lb_user_id ON leaderboard(user_id);");
  } catch (err) {
    console.error("[DB] Failed to create idx_lb_user_id:", err.message);
  }

  // game_plays
  const gpCols = db.prepare("PRAGMA table_info(game_plays)").all();
  if (!gpCols.some(c => c.name === "user_id")) {
    try {
      db.exec("ALTER TABLE game_plays ADD COLUMN user_id TEXT;");
      console.log("[DB] Added user_id column to game_plays.");
    } catch (err) {
      console.error("[DB] Failed to add user_id to game_plays:", err.message);
    }
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_game_plays_user_id ON game_plays(user_id);");
  } catch (err) {
    console.error("[DB] Failed to create idx_game_plays_user_id:", err.message);
  }
})();

// ── One-time migration from legacy JSON files ────────────────
(function migrate() {
  const legacyPaths = {
    daily:       path.join(DB_DIR, "daily.json"),
    leaderboard: path.join(DB_DIR, "leaderboard.json"),
    stats:       path.join(DB_DIR, "daily-stats.json"),
  };

  // Deduplicate leaderboard: keep only the highest score for each name (case-insensitive)
  try {
    const countRows = db.prepare("SELECT COUNT(*) AS n FROM leaderboard").get().n;
    if (countRows > 0) {
      const duplicates = db.prepare(`
        SELECT name, COUNT(*) as cnt 
        FROM leaderboard 
        GROUP BY LOWER(name) 
        HAVING cnt > 1
      `).all();
      if (duplicates.length > 0) {
        console.log(`[DB] Found ${duplicates.length} leaderboard duplicates. Cleansing...`);
        db.transaction(() => {
          for (const dup of duplicates) {
            const rows = db.prepare(`
              SELECT id, score 
              FROM leaderboard 
              WHERE LOWER(name) = ? 
              ORDER BY score DESC, date DESC
            `).all(dup.name.toLowerCase());
            
            const keepId = rows[0].id;
            const deleteStmt = db.prepare("DELETE FROM leaderboard WHERE LOWER(name) = ? AND id != ?");
            deleteStmt.run(dup.name.toLowerCase(), keepId);
          }
        })();
        console.log("[DB] Leaderboard deduplicated successfully");
      }
    }
  } catch (e) {
    console.error("[DB] Leaderboard deduplication failed:", e.message);
  }

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
      const stmt = db.prepare("INSERT INTO leaderboard (name, score, date, user_id) VALUES (?, ?, ?, NULL)");
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
  insertLb:        db.prepare("INSERT INTO leaderboard (name, score, date, user_id) VALUES (?, ?, ?, ?)"),
  trimLb:          db.prepare("DELETE FROM leaderboard WHERE id NOT IN (SELECT id FROM leaderboard ORDER BY score DESC LIMIT 200)"),
  getRankById:     db.prepare("SELECT COUNT(*) + 1 AS rank FROM leaderboard WHERE score > (SELECT score FROM leaderboard WHERE id = ?)"),
  getRankByScore:  db.prepare("SELECT COUNT(*) + 1 AS rank FROM leaderboard WHERE score > ?"),
  getRankedStats:   db.prepare("SELECT COUNT(*) AS total, AVG(score) AS avgScore, MAX(score) AS topScore FROM leaderboard"),
  getRankedByMonth: db.prepare("SELECT substr(date,1,7) AS month, COUNT(*) AS submissions, AVG(score) AS avgScore, MAX(score) AS topScore FROM leaderboard GROUP BY month ORDER BY month"),
  getStatsByDate:  db.prepare("SELECT outcome, words FROM daily_stats WHERE date = ?"),
  addStat:         db.prepare("INSERT INTO daily_stats (date, outcome, words) VALUES (?, ?, ?)"),
  getAllStats:      db.prepare("SELECT date, outcome, words FROM daily_stats ORDER BY date"),

  // Game Play logs
  logGamePlay:        db.prepare("INSERT INTO game_plays (mode, date, timestamp, user_id) VALUES (?, ?, ?, ?)"),
  getGamePlays:       db.prepare("SELECT mode, date, COUNT(*) AS count FROM game_plays GROUP BY mode, date ORDER BY date"),
  getUniqueUserCount: db.prepare(`SELECT COUNT(*) AS total FROM (SELECT user_id FROM game_plays WHERE user_id IS NOT NULL UNION SELECT user_id FROM leaderboard WHERE user_id IS NOT NULL)`),
  getNewUsersByMonth: db.prepare(`SELECT substr(first_date,1,7) AS month, COUNT(*) AS new_users FROM (SELECT user_id, MIN(date) AS first_date FROM (SELECT user_id, date FROM game_plays WHERE user_id IS NOT NULL UNION ALL SELECT user_id, date FROM leaderboard WHERE user_id IS NOT NULL) GROUP BY user_id) GROUP BY month ORDER BY month`),
  getDauByDate:       db.prepare(`SELECT date, COUNT(DISTINCT user_id) AS dau FROM game_plays WHERE user_id IS NOT NULL GROUP BY date ORDER BY date`),
  getGamesPerUser:    db.prepare(`SELECT user_id, COUNT(*) AS games FROM game_plays WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY games`),
  getSongDailyCounts: db.prepare("SELECT song_id AS songID, COUNT(*) AS count FROM daily GROUP BY song_id"),
  getExistingLb:   db.prepare("SELECT id, score, name, date, user_id FROM leaderboard WHERE LOWER(name) = ?"),
  getExistingLbByUid: db.prepare("SELECT id, score, name, date, user_id FROM leaderboard WHERE user_id = ?"),
  updateLb:        db.prepare("UPDATE leaderboard SET score = ?, date = ?, name = ?, user_id = ? WHERE id = ?"),
  deleteLbId:      db.prepare("DELETE FROM leaderboard WHERE id = ?"),
};

module.exports = {
  // ── Daily ────────────────────────────────────────────────────
  getDaily()            { return stmts.getAllDaily.all(); },
  getDailyByDate(date)  { return stmts.getDailyByDate.get(date) || null; },
  upsertDaily({ date, songID, wordIndex }) { stmts.upsertDaily.run(date, songID, wordIndex); },
  deleteDaily(date)     { stmts.deleteDaily.run(date); },

  // ── Leaderboard ──────────────────────────────────────────────
  getLeaderboard(n = 200) { return stmts.getTopLb.all(n); },
  insertLeaderboard({ name, score, date, user_id }) {
    const uid = user_id ? String(user_id).trim() : null;
    const existingByUid = uid ? stmts.getExistingLbByUid.get(uid) : null;
    const existingByName = stmts.getExistingLb.get(name.toLowerCase());
    let rank;

    if (existingByUid && existingByName) {
      if (existingByUid.id === existingByName.id) {
        // Same row: update if score is higher, keep highest and update name casing
        if (score > existingByUid.score) {
          stmts.updateLb.run(score, date, name, uid, existingByUid.id);
          const res = stmts.getRankByScore.get(score);
          rank = res ? res.rank : 1;
        } else {
          // Keep old score, old date, but refresh name casing / user_id if needed
          stmts.updateLb.run(existingByUid.score, existingByUid.date, name, uid, existingByUid.id);
          const res = stmts.getRankByScore.get(existingByUid.score);
          rank = res ? res.rank : 1;
        }
      } else {
        // Different rows: consolidate user's scores
        if (existingByUid.score >= existingByName.score) {
          stmts.deleteLbId.run(existingByName.id);
          if (score > existingByUid.score) {
            stmts.updateLb.run(score, date, name, uid, existingByUid.id);
            const res = stmts.getRankByScore.get(score);
            rank = res ? res.rank : 1;
          } else {
            stmts.updateLb.run(existingByUid.score, existingByUid.date, name, uid, existingByUid.id);
            const res = stmts.getRankByScore.get(existingByUid.score);
            rank = res ? res.rank : 1;
          }
        } else {
          stmts.deleteLbId.run(existingByUid.id);
          if (score > existingByName.score) {
            stmts.updateLb.run(score, date, name, uid, existingByName.id);
            const res = stmts.getRankByScore.get(score);
            rank = res ? res.rank : 1;
          } else {
            stmts.updateLb.run(existingByName.score, existingByName.date, name, uid, existingByName.id);
            const res = stmts.getRankByScore.get(existingByName.score);
            rank = res ? res.rank : 1;
          }
        }
      }
    } else if (existingByUid) {
      // Only UUID exists: player changed nickname
      if (score > existingByUid.score) {
        stmts.updateLb.run(score, date, name, uid, existingByUid.id);
        const res = stmts.getRankByScore.get(score);
        rank = res ? res.rank : 1;
      } else {
        stmts.updateLb.run(existingByUid.score, existingByUid.date, name, uid, existingByUid.id);
        const res = stmts.getRankByScore.get(existingByUid.score);
        rank = res ? res.rank : 1;
      }
    } else if (existingByName) {
      // Only Name matches: player either legacy, or changed device/cleared storage, or chooses exact existing name.
      // Associate with this device's UUID.
      if (score > existingByName.score) {
        stmts.updateLb.run(score, date, name, uid, existingByName.id);
        const res = stmts.getRankByScore.get(score);
        rank = res ? res.rank : 1;
      } else {
        stmts.updateLb.run(existingByName.score, existingByName.date, name, uid, existingByName.id);
        const res = stmts.getRankByScore.get(existingByName.score);
        rank = res ? res.rank : 1;
      }
    } else {
      // Brand new entry
      const { lastInsertRowid } = stmts.insertLb.run(name, score, date, uid);
      const { rank: newRank } = stmts.getRankById.get(lastInsertRowid);
      rank = newRank;
    }

    stmts.trimLb.run();
    return rank;
  },
  getRankedStats()   { return stmts.getRankedStats.get(); },
  getRankedByMonth() { return stmts.getRankedByMonth.all(); },

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

  // ── Game Play logging ────────────────────────────────────────
  logGamePlay(mode, userId, date) {
    const d = date || new Date().toISOString().split("T")[0];
    const uid = userId ? String(userId).trim().slice(0, 128) : null;
    stmts.logGamePlay.run(mode, d, Date.now(), uid);
  },
  getGamePlays() {
    return stmts.getGamePlays.all();
  },

  // ── User analytics ──────────────────────────────────────────────────────
  getUniqueUserCount() { return stmts.getUniqueUserCount.get(); },
  getNewUsersByMonth() { return stmts.getNewUsersByMonth.all(); },
  getDauByDate()       { return stmts.getDauByDate.all(); },
  getGamesPerUser()    { return stmts.getGamesPerUser.all(); },
  getSongDailyCounts() {
    const rows = stmts.getSongDailyCounts.all();
    const map = {};
    for (const r of rows) map[r.songID] = r.count;
    return map;
  },
};
