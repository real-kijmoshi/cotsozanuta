// Central config & shared constants. Requiring this module also loads .env,
// so it must be the first require in the app entry point (index.js).
require("dotenv").config();
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const VIEWS_DIR = path.join(PUBLIC_DIR, "views");

// Song titles matching these are never eligible for gameplay (skits, remixes…).
const SKIP_PATTERNS = /\b(skit|interlude|acapella|remix|intro|outro|bonus|relacja|remaster)\b/i;

module.exports = {
    PORT: process.env.PORT || 3000,
    isProd: process.env.NODE_ENV === "production",
    ROOT,
    PUBLIC_DIR,
    VIEWS_DIR,
    SKIP_PATTERNS,
};
