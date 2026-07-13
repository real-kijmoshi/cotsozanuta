const genius = require("../utils/genius");
const { SKIP_PATTERNS } = require("./config");

// ── Song picker (shared by endless and ranked) ───────────────
// Returns { song, moreSongInfo } or null if no suitable song found.
// albumsParam: comma-separated album IDs/names for pool filtering (endless only)
// usedSongs:   Set of already-played songIds to exclude (ranked only)
// requireAudio: only pick songs that have a YouTube video (audio mode)
async function pickSong(artistId, { albumsParam = '', usedSongs = null, requireAudio = false } = {}) {
    const allSongs = await genius.getAllSongs(artistId);
    if (!allSongs.length) return null;
    let filtered = allSongs.filter(s => !SKIP_PATTERNS.test(s.title));

    // Audio mode: restrict the pool to songs known to have a YouTube video.
    // Uncached songs (youtube unknown) are kept as candidates and verified
    // after fetch in the pick loop below.
    if (requireAudio) {
        filtered = filtered.filter(s => {
            const cached = genius.getSongCacheEntry(s.id);
            return !cached || cached.youtube === undefined || cached.youtube;
        });
        if (!filtered.length) return null;
    }

    const isPrimary = (s) => s.artists.some(a => String(a.id) === String(artistId));
    const albumTracks = [], features = [], singles = [];
        for (const s of filtered) {
        const cached = genius.getSongCacheEntry(s.id);
        const album  = cached?.album ? cached.album : s.album;
        if (!isPrimary(s)) features.push(s);
        else if (album)    albumTracks.push(s);
        else               singles.push(s);
    }

    let customPool = null;
    if (albumsParam) {
        const albumIds = new Set(albumsParam.split(',').slice(0, 50).map(a => a.trim()).filter(Boolean));
        const albumFiltered = filtered.filter(s => {
            const cached = genius.getSongCacheEntry(s.id);
            const album  = cached?.album ? cached.album : s.album;
            return album && albumIds.has(String(album.id ?? album.name));
        });
        if (albumFiltered.length > 0) customPool = albumFiltered;
    }

    const exclude  = (pool) => usedSongs ? pool.filter(s => !usedSongs.has(s.id)) : pool;
    const pickPool = () => {
        if (customPool) return exclude(customPool);
        const ap = exclude(albumTracks), fp = exclude(features), sp = exclude(singles);
        const roll = Math.random();
        if (roll < 0.93 && ap.length) return ap;
        if (roll < 0.97 && fp.length) return fp;
        if (sp.length) return sp;
        return ap.length ? ap : exclude(filtered);
    };

    const seen = new Set();
    for (let i = 0; i < 15; i++) {
        const pool = pickPool();
        if (!pool.length) break;
        const candidate = pool[Math.floor(Math.random() * pool.length)];
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        const info = await genius.getSongById(candidate.id);
        if (!info?.lyrics) continue;
        if (requireAudio && !info.youtube) continue;
        return { song: candidate, moreSongInfo: info };
    }
    return null;
}

module.exports = { pickSong };
