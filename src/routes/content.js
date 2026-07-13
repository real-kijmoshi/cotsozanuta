const express = require("express");
const genius = require("../../utils/genius");
const db = require("../../utils/db");
const state = require("../state");
const { lyricsLimiter, publicGetLimiter } = require("../rateLimiters");

const router = express.Router();

router.get("/lyrics", lyricsLimiter, async (req, res) => {
    const { songId, wordIndex } = req.query;
    if (!songId || !wordIndex) {
        return res.status(400).json({ error: "Missing songId or wordIndex" });
    }
    const songIdInt = parseInt(songId, 10);
    if (!Number.isInteger(songIdInt) || songIdInt <= 0) {
        return res.status(400).json({ error: "Invalid songId" });
    }
    if (!state.otsochodziId || !genius.isArtistSong(state.otsochodziId, songIdInt)) {
        return res.status(404).json({ error: "Song not in Otsochodzi catalog" });
    }

    try {
        const words = await genius.getWordArray(songIdInt);
        if (!words) return res.status(404).json({ error: "Lyrics not available" });
        const idx = parseInt(wordIndex, 10);
        if (!Number.isInteger(idx) || idx < 0 || idx >= words.length) {
            return res.status(400).json({ error: "Invalid wordIndex" });
        }
        // A specific (songId, wordIndex) pair never changes — safe to cache long-term.
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.json({ word: words[idx] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch lyrics" });
    }
});

router.get("/autocomplete/songs", publicGetLimiter, async (req, res) => {
    const { query } = req.query;
    if (!query || query.trim().length < 2) {
        return res.status(400).json({ error: "Query must be at least 2 characters" });
    }

    try {
        // Song list changes only when the cache is refreshed (startup/daily warm).
        // A 60-second private cache avoids redundant processing for rapid keystrokes
        // while still reflecting any song-cache updates within a minute.
        res.setHeader("Cache-Control", "private, max-age=60");
        const songs = await genius.searchCachedSongsByName(query.trim());
        res.json(songs.map(song => ({ id: song.id, title: song.title, cover: song.cover||null, artists: song.artists||[] })));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch autocomplete suggestions" });
    }
});

router.get("/discography", publicGetLimiter, async (req, res) => {
    if (!state.otsochodziId) return res.status(503).json({ error: "Server is initializing" });
    try {
        const allSongs = await genius.getAllSongs(state.otsochodziId);
        const dailyCounts = db.getSongDailyCounts();
        const albumMap = new Map();
        const singles = [];

        // Build album map from allSongs
        for (const s of allSongs) {
            const cached = genius.getSongCacheEntry(s.id);
            const album  = cached?.album ? cached.album : s.album;
            const cover  = cached?.cover  || s.cover  || null;
            const artists = cached?.artists || s.artists || [];
            const songEntry = { id: s.id, title: s.title, cover, artists, dailyCount: dailyCounts[s.id] || 0 };

            if (album?.name) {
                const key = String(album.id ?? album.name);
                if (!albumMap.has(key)) {
                    albumMap.set(key, { albumId: key, albumName: album.name, albumCover: null, albumCoverPrimary: false, songs: [] });
                }
                const entry = albumMap.get(key);
                const isPrimaryOnTrack = artists.some(a => String(a.id) === String(state.otsochodziId));
                if (cover) {
                    if (isPrimaryOnTrack) {
                        // prefer covers from tracks where otsochodzi is present
                        entry.albumCover = cover;
                        entry.albumCoverPrimary = true;
                    } else if (!entry.albumCover) {
                        entry.albumCover = cover;
                    }
                }
                entry.songs.push(songEntry);
            } else {
                singles.push(songEntry);
            }
        }

        // Fallback: include cached songs where otsochodzi appears but weren't returned in getAllSongs
        try {
            const cachedSongs = genius.getAllCachedSongs ? genius.getAllCachedSongs() : [];
            const seenSongIds = new Set(allSongs.map(s => String(s.id)));
            for (const cs of cachedSongs) {
                if (!cs || !cs.id) continue;
                if (seenSongIds.has(String(cs.id))) continue;
                const artists = cs.artists || [];
                if (!artists.some(a => String(a.id) === String(state.otsochodziId))) continue;
                const album = cs.album || null;
                const cover = cs.cover || null;
                const songEntry = { id: cs.id, title: cs.title, cover, artists, dailyCount: dailyCounts[cs.id] || 0 };
                if (album && album.name) {
                    const key = String(album.id ?? album.name);
                    if (!albumMap.has(key)) {
                        albumMap.set(key, { albumId: key, albumName: album.name, albumCover: null, albumCoverPrimary: false, songs: [] });
                    }
                    const entry = albumMap.get(key);
                    if (cover) {
                        // prefer primary track covers (cachedSongs are from various sources — treat as primary here)
                        entry.albumCover = cover;
                    }
                    entry.songs.push(songEntry);
                } else {
                    singles.push(songEntry);
                }
            }
        } catch (e) {
            // ignore fallback errors
        }

        // Classify albums: main albums first, EPs next, appearance-only last.
        const albums = Array.from(albumMap.values()).map(a => {
            const total = a.songs.length || 0;
            const primaryCount = a.songs.reduce((c, s) => c + (s.artists && s.artists.some(ar => String(ar.id) === String(state.otsochodziId)) ? 1 : 0), 0);
            const isAppearanceOnly = primaryCount === 0;
            const isEP = /\bEP\b/i.test(a.albumName) || total > 0 && total <= 4;
            return Object.assign({}, a, { _total: total, _primaryCount: primaryCount, _rank: isAppearanceOnly ? 3 : (isEP ? 2 : 1) });
        }).sort((a, b) => {
            if (a._rank !== b._rank) return a._rank - b._rank;
            // For main albums prefer those with more primary tracks (likely core releases)
            if (a._rank === 1 && b._rank === 1 && a._primaryCount !== b._primaryCount) return b._primaryCount - a._primaryCount;
            return a.albumName.localeCompare(b.albumName, 'pl');
        });
        // Ensure album cover is used for all songs in the album (prefer explicit albumCover, fallback to first song cover)
        for (const alb of albums) {
            if (!alb.albumCover) {
                const found = (alb.songs || []).find(s => s.cover);
                if (found) alb.albumCover = found.cover;
            }
            if (alb.albumCover) {
                for (const s of alb.songs) {
                    if (!s.cover) s.cover = alb.albumCover;
                    else s.cover = alb.albumCover; // force album cover for consistency
                }
            }
        }
        if (singles.length) {
            albums.push({ albumId: '__singles__', albumName: 'Single / Inne', albumCover: null, songs: singles });
        }

        res.setHeader("Cache-Control", "public, max-age=300");
        res.json(albums);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to build discography" });
    }
});

router.get("/albums", publicGetLimiter, async (req, res) => {
    if (!state.otsochodziId) return res.status(503).json({ error: "Server is initializing" });
    if (state.cachedAlbums) return res.json(state.cachedAlbums);
    try {
        const allSongs = await genius.getAllSongs(state.otsochodziId);
        const albumMap = new Map();
        for (const s of allSongs) {
            const cached = genius.getSongCacheEntry(s.id);
            const album = cached?.album ? cached.album : s.album;
            if (album?.name) {
                const key = String(album.id ?? album.name);
                if (!albumMap.has(key)) albumMap.set(key, { id: key, name: album.name, _total: 0, _primaryCount: 0 });
                const entry = albumMap.get(key);
                entry._total = (entry._total || 0) + 1;
                const artists = cached?.artists || s.artists || [];
                if (artists.some(a => String(a.id) === String(state.otsochodziId))) entry._primaryCount = (entry._primaryCount || 0) + 1;
            }
        }
        // Sort by same rules as /api/discography: main, EPs, appearances
        state.cachedAlbums = Array.from(albumMap.values()).map(a => {
            const isAppearanceOnly = (a._primaryCount || 0) === 0;
            const isEP = /\bEP\b/i.test(a.name) || (a._total || 0) > 0 && (a._total || 0) <= 4;
            return Object.assign({}, a, { _rank: isAppearanceOnly ? 3 : (isEP ? 2 : 1) });
        }).sort((a, b) => {
            if (a._rank !== b._rank) return a._rank - b._rank;
            if (a._rank === 1 && b._rank === 1 && (b._primaryCount || 0) !== (a._primaryCount || 0)) return (b._primaryCount || 0) - (a._primaryCount || 0);
            return a.name.localeCompare(b.name, 'pl');
        }).map(a => ({ id: a.id, name: a.name }));
        res.json(state.cachedAlbums);
    } catch (e) {
        console.error("[content] albums:", e.message);
        res.status(500).json({ error: "Failed to fetch albums" });
    }
});

// ── Public: active toasts ─────────────────────────────────────
router.get("/toasts", publicGetLimiter, (req, res) => {
    try {
        const toasts = db.getActiveToasts();
        res.json(toasts);
    } catch (e) {
        console.error("[content] toasts:", e.message);
        res.json([]);
    }
});

module.exports = router;
