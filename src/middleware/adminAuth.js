const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// Constant-time string compare that never leaks length via early return.
function timingSafeEqual(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
        // still run comparison to avoid length-based timing leak
        crypto.timingSafeEqual(ba, Buffer.alloc(ba.length));
        return false;
    }
    return crypto.timingSafeEqual(ba, bb);
}

// Admin auth: accepts either a JWT bearer token (issued by /api/admin/login) or
// the legacy x-admin-password header (timing-safe compare).
function adminAuth(req, res, next) {
    const pwd = process.env.ADMIN_PASSWORD;
    if (!pwd) return res.status(500).json({ error: "ADMIN_PASSWORD not set" });
    // First try JWT Authorization header
    const authHeader = String(req.headers['authorization'] || '')
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        const token = authHeader.slice(7).trim()
        const secret = process.env.ADMIN_JWT_SECRET || pwd
        try {
            const payload = jwt.verify(token, secret)
            if (payload && payload.admin) return next()
        } catch (e) {
            // fallthrough to legacy check
        }
    }
    // Legacy: x-admin-password header (timing-safe)
    const auth = req.headers["x-admin-password"] || "";
    if (!timingSafeEqual(auth, pwd)) return res.status(401).json({ error: "Unauthorized" });
    next();
}

module.exports = { timingSafeEqual, adminAuth };
