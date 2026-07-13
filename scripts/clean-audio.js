#!/usr/bin/env node
/**
 * scripts/clean-audio.js — Remove cached MP3 files older than N days.
 *
 * Usage:
 *   node scripts/clean-audio.js          # default: 30 days
 *   node scripts/clean-audio.js 7        # keep only files from last 7 days
 *   node scripts/clean-audio.js --dry-run # show what would be deleted
 */

const fs   = require("fs");
const path = require("path");

const AUDIO_DIR = path.join(__dirname, "..", "db", "audio");
const MAX_AGE_DAYS = parseInt(process.argv[2], 10) || 30;
const DRY_RUN = process.argv.includes("--dry-run");
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

if (!fs.existsSync(AUDIO_DIR)) {
  console.log("[clean-audio] No audio directory found — nothing to clean.");
  process.exit(0);
}

const files = fs.readdirSync(AUDIO_DIR).filter(f => f.endsWith(".mp3"));
const now = Date.now();
let deleted = 0;
let kept = 0;
let totalBytes = 0;

for (const file of files) {
  const fp = path.join(AUDIO_DIR, file);
  try {
    const stat = fs.statSync(fp);
    if (now - stat.mtimeMs > MAX_AGE_MS) {
      totalBytes += stat.size;
      deleted++;
      if (!DRY_RUN) fs.unlinkSync(fp);
    } else {
      kept++;
    }
  } catch (_) {}
}

const mb = (totalBytes / 1024 / 1024).toFixed(2);
const action = DRY_RUN ? "Would delete" : "Deleted";
console.log(`[clean-audio] ${action} ${deleted} files (${mb} MB), kept ${kept} files`);
