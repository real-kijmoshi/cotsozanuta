const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const VIEWS_DIR = path.join(__dirname, "..", "public", "views");

// ── CLI args ──────────────────────────────────────────────────
// Usage: node scripts/maintenance.js <end-datetime>
//   e.g. node scripts/maintenance.js 2026-07-14T18:00:00Z
//        node scripts/maintenance.js "+2h"
const rawArg = process.argv[2];

function resolveEnd(arg) {
  if (!arg) return Date.now() + 2 * 3600_000; // default: 2h from now

  // Relative offsets: "+30m", "+2h", "+1h30m"
  const rel = arg.match(/^\+(?:(\d+)h)?(?:(\d+)m)?$/);
  if (rel) {
    const h = parseInt(rel[1] || "0", 10);
    const m = parseInt(rel[2] || "0", 10);
    return Date.now() + (h * 3600 + m * 60) * 1000;
  }

  const t = new Date(arg).getTime();
  if (isNaN(t)) {
    console.error(`[MAINT] Invalid datetime: "${arg}"`);
    process.exit(1);
  }
  return t;
}

const END_MS   = resolveEnd(rawArg);
const END_ISO  = new Date(END_MS).toISOString();
const END_STR  = new Date(END_MS).toLocaleString("pl-PL", {
  timeZone: "Europe/Warsaw",
  dateStyle: "full",
  timeStyle: "short",
});

// ── Load & patch HTML ─────────────────────────────────────────
const htmlPath = path.join(VIEWS_DIR, "scheduled-maintenance.html");
let html = fs.readFileSync(htmlPath, "utf8");
html = html.replace("__MAINT_END__", END_ISO);

const BODY = Buffer.from(html);

// ── Server ────────────────────────────────────────────────────
const server = http.createServer((_req, res) => {
  const retryAfter = Math.max(0, Math.ceil((END_MS - Date.now()) / 1000));
  res.writeHead(503, {
    "Content-Type":  "text/html; charset=utf-8",
    "Retry-After":   String(retryAfter),
    "Cache-Control": "no-store",
  });
  res.end(BODY);
});

server.listen(PORT, () => {
  console.log(`[MAINT] Maintenance server running on port ${PORT}`);
  console.log(`[MAINT] Ends at: ${END_STR} (Warsaw)`);
  console.log(`[MAINT]   ISO:   ${END_ISO}`);
  console.log(`[MAINT] All routes return 503 until then.`);
});

// ── Graceful shutdown ─────────────────────────────────────────
function shutdown(sig) {
  console.log(`\n[MAINT] ${sig} received — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
