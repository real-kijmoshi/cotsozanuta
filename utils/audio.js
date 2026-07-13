const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ROOT } = require("../src/config");

const AUDIO_DIR = path.join(ROOT, "db", "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const FAILURES_FILE = path.join(ROOT, "db", "audio-failures.json");
let failedIds = new Set();
try { failedIds = new Set(JSON.parse(fs.readFileSync(FAILURES_FILE, "utf8"))); } catch (_) {}

function saveFailures() {
  fs.writeFileSync(FAILURES_FILE, JSON.stringify([...failedIds]));
}

// Strict YouTube video ID: 11 chars, alphanumeric + _ and -
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function filePath(ytId) {
  return path.join(AUDIO_DIR, `${ytId}.mp3`);
}

function exists(ytId) {
  return fs.existsSync(filePath(ytId));
}

function isFailed(ytId) {
  return failedIds.has(ytId);
}

function clearFailure(ytId) {
  if (failedIds.delete(ytId)) saveFailures();
}

function servePath(ytId) {
  return filePath(ytId);
}

function download(ytId) {
  return new Promise((resolve, reject) => {
    if (!YT_ID_RE.test(ytId)) return reject(new Error(`Invalid YouTube ID: ${ytId}`));
    if (exists(ytId)) return resolve(filePath(ytId));
    if (failedIds.has(ytId)) return reject(new Error(`Previously failed: ${ytId}`));

    const url = `https://www.youtube.com/watch?v=${ytId}`;
    const tmpPath = path.join(AUDIO_DIR, `.${ytId}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    const args = [
      url,
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "5",
      "--no-playlist",
      "--quiet",
      "--no-warnings",
      "--no-check-certificates",
      "--download-sections", "*0:00-0:30",
      "-o", tmpPath,
    ];

    execFile("yt-dlp", args, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[AUDIO] yt-dlp failed for ${ytId}:`, stderr || err.message);
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        failedIds.add(ytId);
        saveFailures();
        return reject(err);
      }
      // yt-dlp may append an extension to the output path
      const candidates = [tmpPath, tmpPath + ".mp3"];
      let found = null;
      for (const c of candidates) {
        if (fs.existsSync(c)) { found = c; break; }
      }
      if (!found) {
        console.error(`[AUDIO] yt-dlp ran but output file not found for ${ytId}`);
        failedIds.add(ytId);
        saveFailures();
        return reject(new Error("yt-dlp ran but output file not found"));
      }
      try {
        fs.renameSync(found, filePath(ytId));
      } catch (_) {
        // Cross-device move fallback
        fs.copyFileSync(found, filePath(ytId));
        try { fs.unlinkSync(found); } catch (_) {}
      }
      resolve(filePath(ytId));
    });
  });
}

module.exports = { exists, download, servePath, AUDIO_DIR, isFailed, clearFailure };
