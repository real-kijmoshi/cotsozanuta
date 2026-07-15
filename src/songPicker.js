const genius = require("../utils/genius");
const { SKIP_PATTERNS } = require("./config");

// ── Auto-daily fallback ──────────────────────────────────────
// When the admin forgets to set a daily for a date, we deterministically pick
// one from the artist's *major albums* (full primary-artist LPs — no EPs, no
// singles, no guest appearances) so the "song of the day" always exists.
//
// Selection is seeded purely from the date string, so a given date always maps
// to the same song and word — preserving the immutability daily games rely on —
// and the result is persisted so it stays fixed even as the catalogue grows.

// Deterministic 32-bit hash of a string (FNV-1a) → seed for the PRNG below.
function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// Small seedable PRNG (mulberry32): same seed → same sequence, no deps.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Returns the pool of songs that belong to the artist's major albums.
// Reuses the same classification as /api/albums: an album is "major" when it
// has primary-artist tracks and is not an EP (name contains "EP", or ≤4 tracks).
function getMajorAlbumSongs(artistId, allSongs) {
    const isPrimary = (s) => (s.artists || []).some(a => String(a.id) === String(artistId));
    const albumStats = new Map();
    const songAlbumKey = new Map();

    for (const s of allSongs) {
        if (SKIP_PATTERNS.test(s.title)) continue;
        const cached = genius.getSongCacheEntry(s.id);
        const album = cached?.album ? cached.album : s.album;
        if (!album?.name) continue;
        const key = String(album.id ?? album.name);
        songAlbumKey.set(s.id, key);
        if (!albumStats.has(key)) albumStats.set(key, { name: album.name, total: 0, primaryCount: 0 });
        const st = albumStats.get(key);
        st.total++;
        if (isPrimary(s)) st.primaryCount++;
    }

    const majorKeys = new Set();
    for (const [key, st] of albumStats) {
        const isAppearanceOnly = st.primaryCount === 0;
        const isEP = /\bEP\b/i.test(st.name) || st.total <= 4;
        if (!isAppearanceOnly && !isEP) majorKeys.add(key);
    }

    return allSongs.filter(s =>
        !SKIP_PATTERNS.test(s.title) &&
        isPrimary(s) &&
        majorKeys.has(songAlbumKey.get(s.id))
    );
}

// Deterministically pick (and persist) a daily song for a date with no entry.
// Returns { songID, wordIndex } or null if no suitable song could be found.
async function autoPickDaily(artistId, date, db) {
    const allSongs = await genius.getAllSongs(artistId);
    if (!allSongs.length) return null;

    let pool = getMajorAlbumSongs(artistId, allSongs);
    if (!pool.length) return null;

    // Stable ordering so the seeded shuffle is reproducible regardless of the
    // order Genius returned songs in.
    pool = pool.slice().sort((a, b) => a.id - b.id);

    const rand = mulberry32(hashString(date));
    // Fisher-Yates shuffle driven by the seeded PRNG → deterministic walk order.
    const order = pool.slice();
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }

    for (const candidate of order) {
        const info = await genius.getSongById(candidate.id);
        const words = info?.lyrics ? info.lyrics.split(/\s+/).filter(Boolean) : null;
        if (!words || !words.length) continue;
        const wordIndex = Math.floor(rand() * words.length);
        db.upsertDaily({ date, songID: candidate.id, wordIndex });
        console.log(`[AUTO-DAILY] No daily set for ${date} — auto-picked "${info.title}" (song ${candidate.id}, word ${wordIndex})`);
        return { songID: candidate.id, wordIndex };
    }
    return null;
}

// ── Song picker (shared by endless and ranked) ───────────────
// Returns { song, moreSongInfo } or null if no suitable song found.
// albumsParam: comma-separated album IDs/names for pool filtering (endless only)
// usedSongs:   Set of already-played songIds to exclude (ranked only)
// requireAudio: only pick songs that have a Deezer preview (audio mode)
async function pickSong(artistId, { albumsParam = '', usedSongs = null, requireAudio = false } = {}) {
    const allSongs = await genius.getAllSongs(artistId);
    if (!allSongs.length) return null;
    let filtered = allSongs.filter(s => !SKIP_PATTERNS.test(s.title));

    // Audio mode: restrict the pool to songs known to have a Deezer preview.
    // Uncached songs (deezer unknown) are kept as candidates and verified
    // after fetch in the pick loop below.
    if (requireAudio) {
        filtered = filtered.filter(s => {
            const cached = genius.getSongCacheEntry(s.id);
            return !cached || cached.deezerId === undefined || cached.deezerId;
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
        if (requireAudio && !info.deezerId) continue;
        return { song: candidate, moreSongInfo: info };
    }
    return null;
}

module.exports = { pickSong, autoPickDaily };
