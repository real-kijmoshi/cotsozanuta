const express = require("express");
const audio = require("../../utils/audio");
const { audioLimiter } = require("../rateLimiters");

const router = express.Router();

// GET /api/audio/:ytId — returns the MP3 (downloads on first request, caches after).
router.get("/:ytId", audioLimiter, async (req, res) => {
  const { ytId } = req.params;
  if (!/^[A-Za-z0-9_-]{11}$/.test(ytId)) {
    return res.status(400).json({ error: "Invalid YouTube ID" });
  }
  try {
    await audio.download(ytId);
    res.sendFile(audio.servePath(ytId), { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=604800" } });
  } catch (err) {
    console.error("[AUDIO] serve error:", err.message);
    res.status(502).json({ error: "Failed to fetch audio" });
  }
});

module.exports = router;
