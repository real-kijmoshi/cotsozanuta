const express = require("express");
const genius = require("../../utils/genius");
const db = require("../../utils/db");
const state = require("../state");
const { pickSong } = require("../songPicker");
const { getCountry } = require("../geo");
const { rankedSessions } = require("../rankedSessions");
const { rankedSongLimiter } = require("../rateLimiters");

const router = express.Router();

router.get("/endless", rankedSongLimiter, async (req, res) => {
    if (!state.otsochodziId) return res.status(503).json({ error: "Server is initializing, try again shortly" });

    const { sessionId } = req.query;
    const rankedSession = sessionId ? rankedSessions.get(String(sessionId)) : null;
    // audio=1 drives the round with a YouTube snippet instead of lyrics; the pool
    // is restricted to songs that carry a YouTube link. Works for plain rounds and
    // ranked sessions alike (Endless / Daily audio use their own dedicated routes).
    const wantAudio = req.query.audio === '1';

    try {
        const albumsParam = !rankedSession ? String(req.query.albums || '').trim() : '';
        const picked = await pickSong(state.otsochodziId, {
            albumsParam,
            usedSongs: rankedSession ? rankedSession.usedSongs : null,
            requireAudio: wantAudio,
        });
        if (!picked) return res.status(wantAudio ? 404 : 500).json({ error: wantAudio ? "Brak piosenek z audio" : "Could not find a song with lyrics" });
        const { song, moreSongInfo } = picked;

        const response = {
            songId:    song.id,
            title:     song.title,
            cover:     moreSongInfo.cover || song.cover || null,
            artists:   moreSongInfo.artists || song.artists || [],
            featured:  moreSongInfo.featured || [],
        };
        if (wantAudio) {
            response.youtube = moreSongInfo.youtube;
        } else {
            const words = await genius.getWordArray(song.id);
            response.wordCount = words.length;
            response.words = words;
        }
        // Hints are not sent in ranked mode — enforced server-side.
        if (!rankedSession) {
            response.hints = { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate };
            const playUid = req.headers['x-user-id'] ? String(req.headers['x-user-id']).trim().slice(0, 128) : null;
            db.logGamePlay(wantAudio ? "audio" : "endless", playUid, null, getCountry(req));
        } else {
            rankedSession.pendingId = song.id;
            rankedSession.issuedAt  = Date.now(); // starts the per-song timer (survival)
            rankedSession.lastActivity = rankedSession.issuedAt;
        }
        res.json(response);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch song" });
    }
});

// ── Audio mode: endless ──────────────────────────────────────
// Same idea as /api/game/endless but the guess is driven by a YouTube snippet
// instead of lyrics: no words are sent, only the YouTube video id. The pool is
// restricted to songs that carry a YouTube link on Genius (i.e. the full
// catalog, including major albums).
router.get("/audio/endless", rankedSongLimiter, async (req, res) => {
    if (!state.otsochodziId) return res.status(503).json({ error: "Server is initializing, try again shortly" });
    try {
        const albumsParam = String(req.query.albums || '').trim();
        const picked = await pickSong(state.otsochodziId, { albumsParam, requireAudio: true });
        if (!picked) return res.status(404).json({ error: "Brak piosenek z audio" });
        const { song, moreSongInfo } = picked;

        const audioUid = req.headers['x-user-id'] ? String(req.headers['x-user-id']).trim().slice(0, 128) : null;
        db.logGamePlay("audio", audioUid, null, getCountry(req));

        res.json({
            songId:   song.id,
            title:    song.title,
            cover:    moreSongInfo.cover || song.cover || null,
            artists:  moreSongInfo.artists || song.artists || [],
            featured: moreSongInfo.featured || [],
            youtube:  moreSongInfo.youtube,
            hints:    { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch audio song" });
    }
});

router.get("/daily/:date", async (req, res) => {
    const { date } = req.params;
    try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: "Invalid date format" });
        }
        if (date > new Date().toISOString().split("T")[0]) {
            return res.status(400).json({ error: "Date cannot be in the future" });
        }

        const dailyData = db.getDailyByDate(date);
        if (!dailyData) {
            return res.status(404).json({ error: "No game found for this date" });
        }

        const { songID, wordIndex } = dailyData;
        const moreSongInfo = await genius.getSongById(songID);
        const words = moreSongInfo?.lyrics ? moreSongInfo.lyrics.split(/\s+/).filter(Boolean) : null;
        // Daily games are immutable — same date always returns same data.
        res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
        res.json({
            songId: songID,
            title: moreSongInfo.title,
            cover: moreSongInfo.cover || null,
            artists: moreSongInfo.artists || [],
            featured: moreSongInfo.featured || [],
            youtube: moreSongInfo.youtube || null,
            hints: { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate },
            wordIndex,
            words
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch daily game data" });
    }
});

module.exports = router;
