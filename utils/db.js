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

  CREATE TABLE IF NOT EXISTS game_results (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    mode           TEXT NOT NULL,
    ranked_mode    TEXT,
    outcome        TEXT NOT NULL,
    words_revealed INTEGER NOT NULL,
    duration_ms    INTEGER,
    user_id        TEXT,
    country        TEXT,
    timestamp      INTEGER NOT NULL,
    date           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gr_date     ON game_results(date);
  CREATE INDEX IF NOT EXISTS idx_gr_mode     ON game_results(mode, date);
  CREATE INDEX IF NOT EXISTS idx_gr_user     ON game_results(user_id);
  CREATE INDEX IF NOT EXISTS idx_gr_outcome  ON game_results(outcome);

  CREATE TABLE IF NOT EXISTS toasts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    subtitle      TEXT DEFAULT '',
    icon          TEXT DEFAULT '🔔',
    bg_color      TEXT DEFAULT '',
    border_color  TEXT DEFAULT '',
    accent_color  TEXT DEFAULT '',
    position      TEXT DEFAULT 'top',
    duration      INTEGER DEFAULT 6500,
    start_date    TEXT,
    end_date      TEXT,
    once_per_user INTEGER DEFAULT 1,
    enabled       INTEGER DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now'))
  );
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
  // country: 2-letter ISO code of where the play came from (best-effort, may be NULL)
  if (!gpCols.some(c => c.name === "country")) {
    try {
      db.exec("ALTER TABLE game_plays ADD COLUMN country TEXT;");
      console.log("[DB] Added country column to game_plays.");
    } catch (err) {
      console.error("[DB] Failed to add country to game_plays:", err.message);
    }
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_game_plays_user_id ON game_plays(user_id);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_game_plays_country ON game_plays(country);");
  } catch (err) {
    console.error("[DB] Failed to create game_plays indexes:", err.message);
  }
})();

// ── Migrate: add per-mode leaderboards ───────────────────────
// Historically there was a single leaderboard (the 60-second ranked run).
// We now keep one board per ranked sub-mode × game_type.
// Existing rows are 60s runs → sprint60, tekst.
const RANKED_MODES = ["sprint60", "sprint180", "survival"];
const DEFAULT_RANKED_MODE = "sprint60";
const GAME_TYPES = ["tekst", "audio"];
const DEFAULT_GAME_TYPE = "tekst";
(function migrateLeaderboardMode() {
  const cols = db.prepare("PRAGMA table_info(leaderboard)").all();
  if (!cols.some(c => c.name === "mode")) {
    try {
      db.exec(`ALTER TABLE leaderboard ADD COLUMN mode TEXT NOT NULL DEFAULT '${DEFAULT_RANKED_MODE}';`);
      db.exec(`UPDATE leaderboard SET mode = '${DEFAULT_RANKED_MODE}' WHERE mode IS NULL OR mode = '';`);
      console.log("[DB] Added mode column to leaderboard (existing rows → sprint60).");
    } catch (err) {
      console.error("[DB] Failed to add mode column:", err.message);
    }
  }
  if (!cols.some(c => c.name === "game_type")) {
    try {
      db.exec(`ALTER TABLE leaderboard ADD COLUMN game_type TEXT NOT NULL DEFAULT '${DEFAULT_GAME_TYPE}';`);
      db.exec(`UPDATE leaderboard SET game_type = '${DEFAULT_GAME_TYPE}' WHERE game_type IS NULL OR game_type = '';`);
      console.log("[DB] Added game_type column to leaderboard (existing rows → tekst).");
    } catch (err) {
      console.error("[DB] Failed to add game_type column:", err.message);
    }
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_lb_mode_score ON leaderboard(mode, score DESC);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_lb_mode_type_score ON leaderboard(mode, game_type, score DESC);");
  } catch (err) {
    console.error("[DB] Failed to create leaderboard indexes:", err.message);
  }
})();

// ── One-time migration from legacy JSON files ────────────────
(function migrate() {
  const legacyPaths = {
    daily:       path.join(DB_DIR, "daily.json"),
    leaderboard: path.join(DB_DIR, "leaderboard.json"),
    stats:       path.join(DB_DIR, "daily-stats.json"),
  };

  // Deduplicate leaderboard: keep only the highest score for each name (case-insensitive) per mode + game_type
  try {
    const countRows = db.prepare("SELECT COUNT(*) AS n FROM leaderboard").get().n;
    if (countRows > 0) {
      const duplicates = db.prepare(`
        SELECT mode, game_type, name, COUNT(*) as cnt
        FROM leaderboard
        GROUP BY mode, game_type, LOWER(name)
        HAVING cnt > 1
      `).all();
      if (duplicates.length > 0) {
        console.log(`[DB] Found ${duplicates.length} leaderboard duplicates. Cleansing...`);
        db.transaction(() => {
          for (const dup of duplicates) {
            const rows = db.prepare(`
              SELECT id, score
              FROM leaderboard
              WHERE mode = ? AND game_type = ? AND LOWER(name) = ?
              ORDER BY score DESC, date DESC
            `).all(dup.mode, dup.game_type, dup.name.toLowerCase());

            const keepId = rows[0].id;
            const deleteStmt = db.prepare("DELETE FROM leaderboard WHERE mode = ? AND game_type = ? AND LOWER(name) = ? AND id != ?");
            deleteStmt.run(dup.mode, dup.game_type, dup.name.toLowerCase(), keepId);
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

  getTopLb:        db.prepare("SELECT name, score, date FROM leaderboard WHERE mode = ? AND game_type = ? ORDER BY score DESC, date ASC LIMIT ?"),
  insertLb:        db.prepare("INSERT INTO leaderboard (name, score, date, user_id, mode, game_type) VALUES (?, ?, ?, ?, ?, ?)"),
  trimLb:          db.prepare("DELETE FROM leaderboard WHERE mode = ? AND game_type = ? AND id NOT IN (SELECT id FROM leaderboard WHERE mode = ? AND game_type = ? ORDER BY score DESC LIMIT 200)"),
  getRankById:     db.prepare("SELECT COUNT(*) + 1 AS rank FROM leaderboard WHERE mode = (SELECT mode FROM leaderboard WHERE id = ?) AND game_type = (SELECT game_type FROM leaderboard WHERE id = ?) AND score > (SELECT score FROM leaderboard WHERE id = ?)"),
  getRankByScore:  db.prepare("SELECT COUNT(*) + 1 AS rank FROM leaderboard WHERE mode = ? AND game_type = ? AND score > ?"),
  getRankedStats:   db.prepare("SELECT COUNT(*) AS total, AVG(score) AS avgScore, MAX(score) AS topScore FROM leaderboard WHERE mode = ? AND game_type = ?"),
  getRankedByMonth: db.prepare("SELECT substr(date,1,7) AS month, COUNT(*) AS submissions, AVG(score) AS avgScore, MAX(score) AS topScore FROM leaderboard WHERE mode = ? AND game_type = ? GROUP BY month ORDER BY month"),
  getStatsByDate:  db.prepare("SELECT outcome, words FROM daily_stats WHERE date = ?"),
  addStat:         db.prepare("INSERT INTO daily_stats (date, outcome, words) VALUES (?, ?, ?)"),
  getAllStats:      db.prepare("SELECT date, outcome, words FROM daily_stats ORDER BY date"),

  // Game Play logs
  logGamePlay:        db.prepare("INSERT INTO game_plays (mode, date, timestamp, user_id, country) VALUES (?, ?, ?, ?, ?)"),
  getGamePlays:       db.prepare("SELECT mode, date, COUNT(*) AS count FROM game_plays GROUP BY mode, date ORDER BY date"),
  getUniqueUserCount: db.prepare(`SELECT COUNT(*) AS total FROM (SELECT user_id FROM game_plays WHERE user_id IS NOT NULL UNION SELECT user_id FROM leaderboard WHERE user_id IS NOT NULL)`),
  getNewUsersByMonth: db.prepare(`SELECT substr(first_date,1,7) AS month, COUNT(*) AS new_users FROM (SELECT user_id, MIN(date) AS first_date FROM (SELECT user_id, date FROM game_plays WHERE user_id IS NOT NULL UNION ALL SELECT user_id, date FROM leaderboard WHERE user_id IS NOT NULL) GROUP BY user_id) GROUP BY month ORDER BY month`),
  getDauByDate:       db.prepare(`SELECT date, COUNT(DISTINCT user_id) AS dau FROM game_plays WHERE user_id IS NOT NULL GROUP BY date ORDER BY date`),
  getGamesPerUser:    db.prepare(`SELECT user_id, COUNT(*) AS games FROM game_plays WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY games`),
  // Category = 'audio' for audio mode, 'text' for lyric-based modes (endless, ranked, daily).
  getGamesPerUserByCat: db.prepare(`SELECT user_id, CASE WHEN mode = 'audio' THEN 'audio' ELSE 'text' END AS category, COUNT(*) AS games FROM game_plays WHERE user_id IS NOT NULL GROUP BY user_id, category ORDER BY games`),
  // Where plays come from, split by audio vs text so the two are reported separately.
  getPlaysByCountry:  db.prepare(`SELECT COALESCE(country, '??') AS country, CASE WHEN mode = 'audio' THEN 'audio' ELSE 'text' END AS category, COUNT(*) AS count FROM game_plays GROUP BY country, category`),
  getUniqueUsersByCountry: db.prepare(`SELECT COALESCE(country, '??') AS country, COUNT(DISTINCT user_id) AS users FROM game_plays WHERE user_id IS NOT NULL GROUP BY country`),
  getSongDailyCounts: db.prepare("SELECT song_id AS songID, COUNT(*) AS count FROM daily GROUP BY song_id"),

  // ── Game Results (comprehensive per-game outcomes) ────────
  insertGameResult: db.prepare(`INSERT INTO game_results (mode, ranked_mode, outcome, words_revealed, duration_ms, user_id, country, timestamp, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  // Per-mode totals
  grModeTotals: db.prepare(`SELECT mode, COUNT(*) AS total, SUM(CASE WHEN outcome='correct' THEN 1 ELSE 0 END) AS wins, SUM(CASE WHEN outcome='giveup' THEN 1 ELSE 0 END) AS giveups, AVG(words_revealed) AS avgWords, MIN(words_revealed) AS minWords, MAX(words_revealed) AS maxWords, AVG(duration_ms) AS avgDuration FROM game_results GROUP BY mode ORDER BY mode`),
  // Per-mode per-day
  grModeByDay: db.prepare(`SELECT date, mode, COUNT(*) AS total, SUM(CASE WHEN outcome='correct' THEN 1 ELSE 0 END) AS wins, SUM(CASE WHEN outcome='giveup' THEN 1 ELSE 0 END) AS giveups, AVG(words_revealed) AS avgWords FROM game_results GROUP BY date, mode ORDER BY date`),
  // Per-mode per-month
  grModeByMonth: db.prepare(`SELECT substr(date,1,7) AS month, mode, COUNT(*) AS total, SUM(CASE WHEN outcome='correct' THEN 1 ELSE 0 END) AS wins, SUM(CASE WHEN outcome='giveup' THEN 1 ELSE 0 END) AS giveups, AVG(words_revealed) AS avgWords FROM game_results GROUP BY month, mode ORDER BY month`),
  // Games per user distribution (for median, percentiles)
  grGamesPerUser: db.prepare(`SELECT user_id, COUNT(*) AS games, SUM(CASE WHEN mode='audio' THEN 1 ELSE 0 END) AS audio_games, SUM(CASE WHEN mode!='audio' THEN 1 ELSE 0 END) AS text_games FROM game_results WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY games`),
  // Word distribution per mode
  grWordDistByMode: db.prepare(`SELECT mode, words_revealed AS words, COUNT(*) AS total, SUM(CASE WHEN outcome='correct' THEN 1 ELSE 0 END) AS correct, SUM(CASE WHEN outcome='giveup' THEN 1 ELSE 0 END) AS giveup FROM game_results GROUP BY mode, words_revealed ORDER BY mode, words_revealed`),
  // Streak data per user (ordered by timestamp for streak computation)
  grStreaksPerUser: db.prepare(`SELECT user_id, timestamp, outcome FROM game_results WHERE user_id IS NOT NULL ORDER BY user_id, timestamp`),
  // DAU from game_results
  grDauByDate: db.prepare(`SELECT date, COUNT(DISTINCT user_id) AS dau FROM game_results WHERE user_id IS NOT NULL GROUP BY date ORDER BY date`),
  // New users from game_results
  grNewUsersByMonth: db.prepare(`SELECT substr(first_date,1,7) AS month, COUNT(*) AS new_users FROM (SELECT user_id, MIN(date) AS first_date FROM game_results WHERE user_id IS NOT NULL GROUP BY user_id) GROUP BY month ORDER BY month`),
  // Retention: users who played in week N and week N+1
  grWauByWeek: db.prepare(`SELECT strftime('%W', date) AS week, substr(date, 1, 4) AS year, COUNT(DISTINCT user_id) AS wau FROM game_results WHERE user_id IS NOT NULL GROUP BY year, week ORDER BY year, week`),
  // Country breakdown per mode
  grByCountry: db.prepare(`SELECT COALESCE(country, '??') AS country, mode, COUNT(*) AS total, SUM(CASE WHEN outcome='correct' THEN 1 ELSE 0 END) AS wins FROM game_results GROUP BY country, mode ORDER BY total DESC`),
  getExistingLb:   db.prepare("SELECT id, score, name, date, user_id FROM leaderboard WHERE mode = ? AND game_type = ? AND LOWER(name) = ?"),
  getExistingLbByUid: db.prepare("SELECT id, score, name, date, user_id FROM leaderboard WHERE mode = ? AND game_type = ? AND user_id = ?"),
  updateLb:        db.prepare("UPDATE leaderboard SET score = ?, date = ?, name = ?, user_id = ? WHERE id = ?"),
  deleteLbId:      db.prepare("DELETE FROM leaderboard WHERE id = ?"),

  // Toasts
  getAllToasts:      db.prepare("SELECT * FROM toasts ORDER BY created_at DESC"),
  getToastById:      db.prepare("SELECT * FROM toasts WHERE id = ?"),
  insertToast:       db.prepare(`INSERT INTO toasts (title, subtitle, icon, bg_color, border_color, accent_color, position, duration, start_date, end_date, once_per_user, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateToast:       db.prepare(`UPDATE toasts SET title=?, subtitle=?, icon=?, bg_color=?, border_color=?, accent_color=?, position=?, duration=?, start_date=?, end_date=?, once_per_user=?, enabled=? WHERE id=?`),
  deleteToast:       db.prepare("DELETE FROM toasts WHERE id = ?"),
  getActiveToasts:   db.prepare(`SELECT * FROM toasts WHERE enabled = 1 AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) ORDER BY created_at DESC`),
};

module.exports = {
  // ── Health ───────────────────────────────────────────────────
  ping() { db.prepare("SELECT 1").get(); },

  // ── Daily ────────────────────────────────────────────────────
  getDaily()            { return stmts.getAllDaily.all(); },
  getDailyByDate(date)  { return stmts.getDailyByDate.get(date) || null; },
  upsertDaily({ date, songID, wordIndex }) { stmts.upsertDaily.run(date, songID, wordIndex); },
  deleteDaily(date)     { stmts.deleteDaily.run(date); },

  // ── Leaderboard ──────────────────────────────────────────────
  RANKED_MODES,
  DEFAULT_RANKED_MODE,
  GAME_TYPES,
  DEFAULT_GAME_TYPE,
  isValidMode(mode) { return RANKED_MODES.includes(mode); },
  normalizeMode(mode) { return RANKED_MODES.includes(mode) ? mode : DEFAULT_RANKED_MODE; },
  isValidGameType(gt) { return GAME_TYPES.includes(gt); },
  normalizeGameType(gt) { return GAME_TYPES.includes(gt) ? gt : DEFAULT_GAME_TYPE; },
  getLeaderboard(mode = DEFAULT_RANKED_MODE, gameType = DEFAULT_GAME_TYPE, n = 200) {
    const m = RANKED_MODES.includes(mode) ? mode : DEFAULT_RANKED_MODE;
    const gt = GAME_TYPES.includes(gameType) ? gameType : DEFAULT_GAME_TYPE;
    return stmts.getTopLb.all(m, gt, n);
  },
  insertLeaderboard({ name, score, date, user_id, mode, game_type }) {
    const m = RANKED_MODES.includes(mode) ? mode : DEFAULT_RANKED_MODE;
    const gt = GAME_TYPES.includes(game_type) ? game_type : DEFAULT_GAME_TYPE;
    const uid = user_id ? String(user_id).trim() : null;
    const existingByUid = uid ? stmts.getExistingLbByUid.get(m, gt, uid) : null;
    const existingByName = stmts.getExistingLb.get(m, gt, name.toLowerCase());
    let rank;

    if (existingByUid && existingByName) {
      if (existingByUid.id === existingByName.id) {
        if (score > existingByUid.score) {
          stmts.updateLb.run(score, date, name, uid, existingByUid.id);
          const res = stmts.getRankByScore.get(m, gt, score);
          rank = res ? res.rank : 1;
        } else {
          stmts.updateLb.run(existingByUid.score, existingByUid.date, name, uid, existingByUid.id);
          const res = stmts.getRankByScore.get(m, gt, existingByUid.score);
          rank = res ? res.rank : 1;
        }
      } else {
        if (existingByUid.score >= existingByName.score) {
          stmts.deleteLbId.run(existingByName.id);
          if (score > existingByUid.score) {
            stmts.updateLb.run(score, date, name, uid, existingByUid.id);
            const res = stmts.getRankByScore.get(m, gt, score);
            rank = res ? res.rank : 1;
          } else {
            stmts.updateLb.run(existingByUid.score, existingByUid.date, name, uid, existingByUid.id);
            const res = stmts.getRankByScore.get(m, gt, existingByUid.score);
            rank = res ? res.rank : 1;
          }
        } else {
          stmts.deleteLbId.run(existingByUid.id);
          if (score > existingByName.score) {
            stmts.updateLb.run(score, date, name, uid, existingByName.id);
            const res = stmts.getRankByScore.get(m, gt, score);
            rank = res ? res.rank : 1;
          } else {
            stmts.updateLb.run(existingByName.score, existingByName.date, name, uid, existingByName.id);
            const res = stmts.getRankByScore.get(m, gt, existingByName.score);
            rank = res ? res.rank : 1;
          }
        }
      }
    } else if (existingByUid) {
      if (score > existingByUid.score) {
        stmts.updateLb.run(score, date, name, uid, existingByUid.id);
        const res = stmts.getRankByScore.get(m, gt, score);
        rank = res ? res.rank : 1;
      } else {
        stmts.updateLb.run(existingByUid.score, existingByUid.date, name, uid, existingByUid.id);
        const res = stmts.getRankByScore.get(m, gt, existingByUid.score);
        rank = res ? res.rank : 1;
      }
    } else if (existingByName) {
      if (score > existingByName.score) {
        stmts.updateLb.run(score, date, name, uid, existingByName.id);
        const res = stmts.getRankByScore.get(m, gt, score);
        rank = res ? res.rank : 1;
      } else {
        stmts.updateLb.run(existingByName.score, existingByName.date, name, uid, existingByName.id);
        const res = stmts.getRankByScore.get(m, gt, existingByName.score);
        rank = res ? res.rank : 1;
      }
    } else {
      const { lastInsertRowid } = stmts.insertLb.run(name, score, date, uid, m, gt);
      const { rank: newRank } = stmts.getRankById.get(lastInsertRowid, lastInsertRowid, lastInsertRowid);
      rank = newRank;
    }

    stmts.trimLb.run(m, gt, m, gt);
    return rank;
  },
  getRankedStats(mode = DEFAULT_RANKED_MODE, gameType = DEFAULT_GAME_TYPE)   { return stmts.getRankedStats.get(RANKED_MODES.includes(mode) ? mode : DEFAULT_RANKED_MODE, GAME_TYPES.includes(gameType) ? gameType : DEFAULT_GAME_TYPE); },
  getRankedByMonth(mode = DEFAULT_RANKED_MODE, gameType = DEFAULT_GAME_TYPE) { return stmts.getRankedByMonth.all(RANKED_MODES.includes(mode) ? mode : DEFAULT_RANKED_MODE, GAME_TYPES.includes(gameType) ? gameType : DEFAULT_GAME_TYPE); },

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
  logGamePlay(mode, userId, date, country) {
    const d = date || new Date().toISOString().split("T")[0];
    const uid = userId ? String(userId).trim().slice(0, 128) : null;
    const cc  = country ? String(country).trim().toUpperCase().slice(0, 2) : null;
    stmts.logGamePlay.run(mode, d, Date.now(), uid, cc);
  },
  getGamePlays() {
    return stmts.getGamePlays.all();
  },
  getGamesPerUserByCat() { return stmts.getGamesPerUserByCat.all(); },
  getPlaysByCountry()    { return stmts.getPlaysByCountry.all(); },
  getUniqueUsersByCountry() { return stmts.getUniqueUsersByCountry.all(); },

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

  // ── Game Results (comprehensive per-game outcomes) ─────────
  logGameResult({ mode, rankedMode, outcome, wordsRevealed, durationMs, userId, country }) {
    const d = new Date().toISOString().split("T")[0];
    const uid = userId ? String(userId).trim().slice(0, 128) : null;
    const cc  = country ? String(country).trim().toUpperCase().slice(0, 2) : null;
    stmts.insertGameResult.run(mode, rankedMode || null, outcome, wordsRevealed || 0, durationMs || null, uid, cc, Date.now(), d);
  },
  getGameResultModeTotals()  { return stmts.grModeTotals.all(); },
  getGameResultModeByDay()   { return stmts.grModeByDay.all(); },
  getGameResultModeByMonth() { return stmts.grModeByMonth.all(); },
  getGameResultGamesPerUser(){ return stmts.grGamesPerUser.all(); },
  getGameResultWordDist()    { return stmts.grWordDistByMode.all(); },
  getGameResultStreaks()     { return stmts.grStreaksPerUser.all(); },
  getGameResultDauByDate()   { return stmts.grDauByDate.all(); },
  getGameResultNewUsersByMonth() { return stmts.grNewUsersByMonth.all(); },
  getGameResultWauByWeek()   { return stmts.grWauByWeek.all(); },
  getGameResultByCountry()   { return stmts.grByCountry.all(); },

  // ── Toasts ──────────────────────────────────────────────────
  getAllToasts() { return stmts.getAllToasts.all(); },
  getToastById(id) { return stmts.getToastById.get(id) || null; },
  getActiveToasts(now) {
    const d = now || new Date().toISOString().slice(0, 10);
    return stmts.getActiveToasts.all(d, d);
  },
  insertToast(t) {
    const r = stmts.insertToast.run(t.title, t.subtitle||'', t.icon||'🔔', t.bg_color||'', t.border_color||'', t.accent_color||'', t.position||'top', t.duration??6500, t.start_date||null, t.end_date||null, t.once_per_user?1:0, t.enabled?1:0);
    return r.lastInsertRowid;
  },
  updateToast(id, t) {
    stmts.updateToast.run(t.title, t.subtitle||'', t.icon||'🔔', t.bg_color||'', t.border_color||'', t.accent_color||'', t.position||'top', t.duration??6500, t.start_date||null, t.end_date||null, t.once_per_user?1:0, t.enabled?1:0, id);
  },
  deleteToast(id) { stmts.deleteToast.run(id); },
};
