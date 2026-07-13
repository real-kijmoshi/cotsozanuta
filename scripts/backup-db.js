#!/usr/bin/env node
/**
 * scripts/backup-db.js — Snapshot the SQLite database using VACUUM INTO.
 *
 * Usage:
 *   node scripts/backup-db.js                     # writes to db/backup-YYYY-MM-DD-HHmmss.db
 *   node scripts/backup-db.js /path/to/output.db  # writes to a specific path
 *
 * The backup is a consistent, single-file copy safe for offsite storage.
 * Run via cron for regular backups:
 *   0 3 * * * cd /path/to/cotsozanuta && node scripts/backup-db.js
 */

const path = require("path");
const fs   = require("fs");
const Database = require("better-sqlite3");

const DB_DIR  = path.join(__dirname, "..", "db");
const DB_PATH = path.join(DB_DIR, "app.db");

if (!fs.existsSync(DB_PATH)) {
  console.error(`[backup] No database found at ${DB_PATH}`);
  process.exit(1);
}

const outPath = path.resolve(process.argv[2] || path.join(
  DB_DIR,
  `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.db`
));

// Reject paths with characters that could break the SQL statement
if (/[']/ .test(outPath)) {
  console.error("[backup] Output path contains invalid characters");
  process.exit(1);
}

// Ensure output directory exists
const outDir = path.dirname(outPath);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

try {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`VACUUM INTO '${outPath}'`);
  db.close();

  const size = fs.statSync(outPath).size;
  const mb = (size / 1024 / 1024).toFixed(2);
  console.log(`[backup] Database backed up to ${outPath} (${mb} MB)`);
} catch (err) {
  console.error(`[backup] Failed: ${err.message}`);
  process.exit(1);
}
