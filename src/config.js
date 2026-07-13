// Central config & shared constants. Requiring this module also loads .env,
// so it must be the first require in the app entry point (index.js).
require("dotenv").config();
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const VIEWS_DIR = path.join(PUBLIC_DIR, "views");

// Song titles matching these are never eligible for gameplay (skits, remixes…).
const SKIP_PATTERNS = /\b(skit|interlude|acapella|remix|intro|outro|bonus|relacja|remaster)\b/i;

// ── Validate critical secrets at boot ─────────────────────────
const _REQUIRED = ["GENIUS_ACCESS_TOKEN"];
for (const key of _REQUIRED) {
    if (!process.env[key]) {
        console.error(`[CONFIG] ❌  ${key} is not set — the app cannot start without it. Add it to .env`);
        process.exit(1);
    }
}
const _INSECURE_PASSWORDS = new Set([
    "change_this_to_a_strong_random_password",
    "password",
    "admin",
    "changeme",
]);
if (process.env.ADMIN_PASSWORD && _INSECURE_PASSWORDS.has(process.env.ADMIN_PASSWORD)) {
    console.error("[CONFIG] ⚠  ADMIN_PASSWORD is insecure or unchanged — set a strong random value in .env");
}
if (!process.env.ADMIN_JWT_SECRET || process.env.ADMIN_JWT_SECRET.length < 32) {
    console.error("[CONFIG] ❌  ADMIN_JWT_SECRET is missing or too short (≥32 chars) — generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    process.exit(1);
}

module.exports = {
    PORT: process.env.PORT || 3000,
    isProd: process.env.NODE_ENV === "production",
    ROOT,
    PUBLIC_DIR,
    VIEWS_DIR,
    SKIP_PATTERNS,
};
