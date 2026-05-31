const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const api = axios.create({
  baseURL: "https://api.genius.com",
  headers: {
    Authorization: `Bearer ${process.env.GENIUS_ACCESS_TOKEN}`,
  },
  timeout: 10000,
});

// Cache management
const cacheDir = path.join(__dirname, "../db/cache");
const artistCache = new Map();
const songCache = new Map();
const lyricsCache = new Map();
// In-flight deduplication: multiple concurrent callers for the same uncached
// song share one promise instead of hammering the Genius API in parallel.
const inFlightSongs = new Map();

// Initialize cache directory
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// Granular per-cache saves — only write the file that actually changed.
// saveSongCache is debounced (2 s) to batch the write storm during warm-up
// when many songs are fetched concurrently.
const saveArtistCache = () =>
  fs.writeFileSync(path.join(cacheDir, "artists.json"), JSON.stringify(Array.from(artistCache.entries())));
let _saveSongCacheTimer = null;
const saveSongCache = () => {
  clearTimeout(_saveSongCacheTimer);
  _saveSongCacheTimer = setTimeout(
    () => fs.writeFileSync(path.join(cacheDir, "songs.json"), JSON.stringify(Array.from(songCache.entries()))),
    2000
  );
};
const flushSongCache = () => {
  if (_saveSongCacheTimer === null) return;
  clearTimeout(_saveSongCacheTimer);
  _saveSongCacheTimer = null;
  fs.writeFileSync(path.join(cacheDir, "songs.json"), JSON.stringify(Array.from(songCache.entries())));
};
const saveLyricsCache = () =>
  fs.writeFileSync(path.join(cacheDir, "lyrics.json"), JSON.stringify(Array.from(lyricsCache.entries())));

// Load cache from disk
const loadCacheFile = (filename, map) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(cacheDir, filename)));
    data.forEach(([key, value]) => map.set(key, value));
  } catch (err) {
    // file missing or corrupt — start with empty map for this cache
  }
};

const loadCache = () => {
  loadCacheFile("artists.json", artistCache);
  loadCacheFile("songs.json", songCache);
  loadCacheFile("lyrics.json", lyricsCache);
};

// Load cache on startup
loadCache();

const getArtistIdByName = async (artistName) => {
  const cacheKey = artistName.toLowerCase();
  
  if (artistCache.has(cacheKey)) {
    return artistCache.get(cacheKey);
  }
  
  try {
    const response = await api.get("/search", {
      params: { q: artistName },
    });
    
    const hits = response.data.response.hits;
    
    if (hits.length > 0) {
      const artistId = hits[0].result.primary_artist.id;
      artistCache.set(cacheKey, artistId);
      saveArtistCache();
      return artistId;
    }
    
    return null;
  } catch (error) {
    console.error("Error fetching artist ID:", error.message);
    return null;
  }
};

const cleanLyrics = (raw) => {
  return raw
    .replace(/^\d+\s*Contributors?.*?Lyrics/s, '')  // strip "X Contributors...Lyrics" prefix
    .replace(/^[\s\S]*?Read More\s*/i, '')           // strip description text up to "Read More"
    .replace(/ZNAJDZIECIE NAS RÓWNIEŻ NA INSTAGRAMIE![\s\S]*?(?=\[|$)/gi, '') // strip Rap Genius PL boilerplate
    .replace(/Rap Genius dla[^\n]*/gi, '')           // strip "Rap Genius dla Początkujących?" etc
    .replace(/Jak korzystać z Rap Genius[^\n]*/gi, '')
    .replace(/Jak tworzyć własne (wyjaśnienia|adnotacje)[^\n]*/gi, '')
    .replace(/\[Tekst i adnotacje na Rap Genius Polska\]\s*/gi, '') // strip common footer
    .replace(/\[[^\]]+\]\n?/g, '')                   // strip section headers like [Refren], [Verse 1: Artist]
    .replace(/\n{3,}/g, '\n\n')                      // collapse excessive blank lines
    .trim();
};

const scrapeLyrics = async (songUrl) => {
  try {
    const response = await axios.get(songUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
      timeout: 10000,
    });
    const $ = cheerio.load(response.data);
    const parts = [];
    $('[data-lyrics-container="true"]').each((_, el) => {
      $("br", el).replaceWith("\n");
      parts.push($(el).text());
    });
    return parts.length ? cleanLyrics(parts.join("\n").trim()) : null;
  } catch (error) {
    console.error("Error scraping lyrics:", error.message);
    return null;
  }
};

const getAllSongs = async (artistId) => {
  const cacheKey = `artist_${artistId}`;
  
  if (songCache.has(cacheKey)) {
    const cached = songCache.get(cacheKey);
    // Re-fetch if the cached list predates album support (old format has no album property).
    if (!cached.length || cached[0].album !== undefined) {
      return cached;
    }
    console.log(`[CACHE] Stale song list (no album data), re-fetching...`);
    songCache.delete(cacheKey);
  }
  
  let songs = [];
  let page = 1;
  let hasMore = true;

  let retries = 0;
  const MAX_RETRIES = 3;
  while (hasMore) {
    try {
      const response = await api.get(`/artists/${artistId}/songs`, {
        params: { page, per_page: 50 },
      });
      const newSongs = response.data.response.songs.map((s) => ({
        id: s.id,
        title: s.title,
        cover: s.song_art_image_url || null,
        artists: s.primary_artists
          ? s.primary_artists.map(a => ({ id: a.id, name: a.name }))
          : [{ id: s.primary_artist.id, name: s.primary_artist.name }],
        url: s.url,
        album: s.album ? { id: s.album.id, name: s.album.name } : null,
      }));
      songs = songs.concat(newSongs);
      hasMore = response.data.response.next_page != null;
      page++;
      retries = 0;
    } catch (error) {
      console.error("Error fetching songs for artist:", error.message);
      if (error.code === "ECONNABORTED" && retries < MAX_RETRIES) {
        retries++;
        console.log(`Request timed out. Retry ${retries}/${MAX_RETRIES}...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      break;
    }
  }
  
  songCache.set(cacheKey, songs);
  saveSongCache();
  return songs;
};

const searchSongsByName = async (songName) => {
  try {
    const response = await api.get("/search", {
      params: { q: songName },
    });
    
    const hits = response.data.response.hits;
    return hits.map(hit => ({
      id: hit.result.id,
      title: hit.result.title,
      cover: hit.result.song_art_image_url || null,
      artists: hit.result.primary_artists
        ? hit.result.primary_artists.map(a => ({ id: a.id, name: a.name }))
        : [{ id: hit.result.primary_artist.id, name: hit.result.primary_artist.name }],
      url: hit.result.url,
    }));
  } catch (error) {
    console.error("Error searching songs:", error.message);
    return [];
  }
};

const searchCachedSongsByName = (songName) => {
  // Normalise query once; split into buckets by match quality so results are
  // ranked: exact > prefix > substring.
  const q = songName.toLowerCase();
  const exact = [], prefix = [], substring = [];
  for (const [key, songs] of songCache.entries()) {
    if (!key.startsWith("artist_")) continue;
    for (const song of songs) {
      const t = song.title.toLowerCase();
      if (t === q)           exact.push(song);
      else if (t.startsWith(q)) prefix.push(song);
      else if (t.includes(q))   substring.push(song);
    }
  }
  // Cap server-side so the wire payload stays small.
  return [...exact, ...prefix, ...substring].slice(0, 10);
};

const matchSingleWithAlbum = async (song) => {
  try {
    const response = await api.get("/search", {
      params: { q: `${song.title} ${song.primary_artist.name}` },
    });
    
    const hits = response.data.response.hits;
    
    for (const hit of hits) {
      const result = hit.result;
      if (result.primary_artist.id === song.primary_artist.id && 
          result.title.toLowerCase() === song.title.toLowerCase() &&
          result.album && 
          result.song_art_image_url) {
        return {
          albumTitle: result.album.name,
          albumCover: result.song_art_image_url,
          albumUrl: result.album.url,
        };
      }
    }
    return null;
  } catch (error) {
    console.error("Error matching single with album:", error.message);
    return null;
  }
};

const getSongById = async (songId) => {
  const cacheKey = String(songId);
  if (songCache.has(cacheKey)) return songCache.get(cacheKey);

  // If another caller is already fetching this song, share that promise.
  if (inFlightSongs.has(cacheKey)) return inFlightSongs.get(cacheKey);

  const promise = (async () => {
    try {
      const response = await api.get(`/songs/${songId}`);
      const song = response.data.response.song;

      const feats = song.featured_artists && song.featured_artists.length > 0
        ? song.featured_artists.map(a => ({ id: a.id, name: a.name }))
        : [];

      let lyrics = lyricsCache.get(song.id) ?? null;
      if (lyrics === null) {
        lyrics = await scrapeLyrics(song.url);
        lyricsCache.set(song.id, lyrics);
        saveLyricsCache();
      }

      const result = {
        id: song.id,
        title: song.title,
        cover: song.song_art_image_url || null,
        artists: song.primary_artists && song.primary_artists.length > 0
          ? song.primary_artists.map(a => ({ id: a.id, name: a.name }))
          : [{ id: song.primary_artist.id, name: song.primary_artist.name }],
        album: song.album ? { id: song.album.id, name: song.album.name } : null,
        releaseDate: song.release_date_for_display || null,
        featured: feats,
        lyrics,
      };

      if (!song.album && song.release_date) {
        const albumInfo = await matchSingleWithAlbum(song);
        if (albumInfo) {
          result.album = { id: null, name: albumInfo.albumTitle };
          result.cover = albumInfo.albumCover;
        }
      }

      songCache.set(cacheKey, result);
      saveSongCache();
      return result;
    } catch (error) {
      console.error("Error fetching song:", error.message);
      return null;
    } finally {
      inFlightSongs.delete(cacheKey);
    }
  })();

  inFlightSongs.set(cacheKey, promise);
  return promise;
};

const clearCache = () => {
  artistCache.clear();
  songCache.clear();
  lyricsCache.clear();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  console.log("Cache cleared");
};

const getSongCacheEntry = (songId) => songCache.get(String(songId)) || null;

// Returns true only if the given songId is in the artist's known song list.
// Prevents arbitrary song IDs from being looked up and polluting the cache.
const isArtistSong = (artistId, songId) => {
  const songs = songCache.get(`artist_${artistId}`);
  if (!songs) return false;
  return songs.some(s => String(s.id) === String(songId));
};

// In-memory word array cache — avoids re-splitting lyrics on every /api/lyrics request.
const wordArrayCache = new Map();

const getWordArray = async (songId) => {
  const key = String(songId);
  if (wordArrayCache.has(key)) return wordArrayCache.get(key);
  const song = await getSongById(songId);
  if (!song?.lyrics) return null;
  const words = song.lyrics.split(/\s+/).filter(Boolean);
  wordArrayCache.set(key, words);
  return words;
};

module.exports = {
  getArtistIdByName,
  getAllSongs,
  searchSongsByName,
  getSongById,
  getSongCacheEntry,
  getWordArray,
  isArtistSong,
  searchCachedSongsByName,
  clearCache,
  flushSongCache,
};
