const genius = require("../utils/genius");
const db = require("../utils/db");
const state = require("./state");
const { SKIP_PATTERNS } = require("./config");

// Resolve the artist, pre-warm today's/tomorrow's daily lyrics so the first
// player gets no cold delay, then open traffic and gradually warm the rest of
// the catalog in the background. Mutates shared `state` so route handlers see
// otsochodziId flip from null and cachedAlbums reset once new album data lands.
async function runWarmup() {
  try {
    const artistId = await genius.getArtistIdByName("otsochodzi");
    if (!artistId) { console.error("[WARM] Could not resolve artist ID, game endpoints will be unavailable"); return; }

    // Fetch full song list — now includes album data for every song.
    const allSongs = await genius.getAllSongs(artistId);
    console.log(`[WARM] Song list loaded: ${allSongs.length} songs`);

    // Pre-warm daily songs (today + tomorrow) so the first player gets no cold delay.
    const today    = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    for (const entry of db.getDaily().filter(e => e.date === today || e.date === tomorrow)) {
      try {
        await genius.getWordArray(entry.songID);
        console.log(`[WARM] Pre-warmed lyrics for daily ${entry.date}`);
      } catch (e) {
        console.error(`[WARM] Failed for daily ${entry.date}:`, e.message);
      }
    }

    // Open traffic immediately after daily songs are ready.
    state.otsochodziId = artistId;
    console.log(`[WARM] Server ready — game endpoints open`);

    // Background: gradually warm the entire catalog (all uncached songs) so
    // every song becomes eligible over time without hammering the Genius API.
    const toWarm = allSongs.filter(s => !SKIP_PATTERNS.test(s.title) && !genius.getSongCacheEntry(s.id));
    const cachedCount = allSongs.length - toWarm.length;
    if (toWarm.length > 0) {
      console.log(`[WARM] Gradual background warm-up: ${toWarm.length} songs queued (${cachedCount} already cached)`);
      const CONCURRENCY = 3;
      const BATCH_DELAY = 1000; // ms between batches — gentle on the API
      const logEvery = Math.max(1, Math.floor(toWarm.length / 10)); // log ~every 10%
      (async () => {
        let done = 0;
        for (let i = 0; i < toWarm.length; i += CONCURRENCY) {
          await Promise.all(
            toWarm.slice(i, i + CONCURRENCY).map(s => genius.getSongById(s.id).catch(() => null))
          );
          done = Math.min(i + CONCURRENCY, toWarm.length);
          if (done % logEvery < CONCURRENCY || done === toWarm.length) {
            console.log(`[WARM] ${done}/${toWarm.length} songs warmed`);
          }
          if (i + CONCURRENCY < toWarm.length) await new Promise(r => setTimeout(r, BATCH_DELAY));
        }
        console.log(`[WARM] Background warm-up complete — all ${toWarm.length} songs cached`);
        state.cachedAlbums = null; // reset so /api/albums reflects newly warmed album data
      })();
    } else {
      console.log(`[WARM] All ${allSongs.length} songs already cached`);
    }
  } catch (e) {
    console.error("[WARM] Startup warm-up failed:", e.message);
  }
}

module.exports = { runWarmup };
