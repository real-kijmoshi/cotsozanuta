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

// Initialize cache directory
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// Save cache to disk
const saveCache = () => {
  fs.writeFileSync(
    path.join(cacheDir, "artists.json"),
    JSON.stringify(Array.from(artistCache.entries()))
  );
  fs.writeFileSync(
    path.join(cacheDir, "songs.json"),
    JSON.stringify(Array.from(songCache.entries()))
  );
  fs.writeFileSync(
    path.join(cacheDir, "lyrics.json"),
    JSON.stringify(Array.from(lyricsCache.entries()))
  );
};

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

const getSongListForArtist = async (artistId) => {
  try {
    const response = await api.get(`/artists/${artistId}/songs`);
    return response.data.response.songs;
  } catch (error) {
    console.error("Error fetching songs for artist:", error.message);
    return [];
  }
};

const getArtistIdByName = async (artistName) => {
  const cacheKey = artistName.toLowerCase();
  
  if (artistCache.has(cacheKey)) {
    console.log(`[CACHE] Artist "${artistName}" found`);
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
      saveCache();
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

const getSongLyrics = async (songId) => {
  if (lyricsCache.has(songId)) {
    console.log(`[CACHE] Lyrics for song ${songId} found`);
    return lyricsCache.get(songId);
  }

  try {
    const response = await api.get(`/songs/${songId}`);
    const song = response.data.response.song;
    const lyrics = await scrapeLyrics(song.url);
    lyricsCache.set(songId, lyrics);
    saveCache();
    return lyrics;
  } catch (error) {
    console.error("Error fetching song lyrics:", error.message);
    return null;
  }
};

const getAllSongs = async (artistId) => {
  const cacheKey = `artist_${artistId}`;
  
  if (songCache.has(cacheKey)) {
    console.log(`[CACHE] All songs for artist ${artistId} found`);
    return songCache.get(cacheKey);
  }
  
  let songs = [];
  let page = 1;
  let hasMore = true;

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
      }));
      songs = songs.concat(newSongs);
      hasMore = response.data.response.songs.length > 0;
      page++;
    } catch (error) {
      console.error("Error fetching songs for artist:", error.message);
      if (error.code === "ECONNABORTED") {
        console.log("Request timed out. Retrying...");
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      break;
    }
  }
  
  songCache.set(cacheKey, songs);
  saveCache();
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
  //search songs in cache by name
  const results = [];
  for (const [key, songs] of songCache.entries()) {
    if (key.startsWith("artist_")) {
      songs.forEach(song => {
        if (song.title.toLowerCase().includes(songName.toLowerCase())) {
          results.push(song);
        }
      });
    }
  }
  return results;
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
  if (songCache.has(cacheKey)) {
    return songCache.get(cacheKey);
  }

  try {
    const response = await api.get(`/songs/${songId}`);
    const song = response.data.response.song;
    
    const feats = song.featured_artists && song.featured_artists.length > 0
      ? song.featured_artists.map(a => ({ id: a.id, name: a.name }))
      : [];

    const lyrics = lyricsCache.has(song.id)
      ? lyricsCache.get(song.id)
      : await scrapeLyrics(song.url);

    if (!lyricsCache.has(song.id)) {
      lyricsCache.set(song.id, lyrics);
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

    songCache.set(String(songId), result);
    saveCache();
    return result;
  } catch (error) {
    console.error("Error fetching song:", error.message);
    return null;
  }
};

const getArtistInfo = async (artistId) => {
  try {
    const response = await api.get(`/artists/${artistId}`);
    const artist = response.data.response.artist;
    return {
      id: artist.id,
      name: artist.name,
      url: artist.url,
      imageUrl: artist.image_url,
      description: artist.description?.plain || null,
    };
  } catch (error) {
    console.error("Error fetching artist info:", error.message);
    return null;
  }
};

const searchArtistsByName = async (artistName) => {
  try {
    const response = await api.get("/search", {
      params: { q: artistName },
    });
    
    const hits = response.data.response.hits;
    const artists = new Map();
    
    hits.forEach(hit => {
      const artist = hit.result.primary_artist;
      if (!artists.has(artist.id)) {
        artists.set(artist.id, {
          id: artist.id,
          name: artist.name,
          url: artist.url,
        });
      }
    });
    
    return Array.from(artists.values());
  } catch (error) {
    console.error("Error searching artists:", error.message);
    return [];
  }
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
  getSongListForArtist,
  getSongLyrics,
  getAllSongs,
  searchSongsByName,
  getSongById,
  getSongCacheEntry,
  getWordArray,
  isArtistSong,
  getArtistInfo,
  searchArtistsByName,
  searchCachedSongsByName,
  clearCache,
};
