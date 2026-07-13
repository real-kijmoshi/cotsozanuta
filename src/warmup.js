const genius = require("../utils/genius");
const audio = require("../utils/audio");
const db = require("../utils/db");
const state = require("./state");
const { SKIP_PATTERNS } = require("./config");

// progress = { phase, current, total, message, error }
async function runWarmup(onProgress) {
  const emit = (p) => { try { onProgress(p); } catch (_) {} };

  try {
    // ── Phase 1: resolve artist ────────────────────────────────
    emit({ phase: "init", current: 0, total: 1, message: "Ładowanie artysty..." });
    const artistId = await genius.getArtistIdByName("otsochodzi");
    if (!artistId) { emit({ phase: "error", message: "Nie udało się załadować artysty" }); return false; }

    const allSongs = await genius.getAllSongs(artistId);
    emit({ phase: "init", current: 1, total: 1, message: `Znaleziono ${allSongs.length} piosenek` });

    // ── Phase 2: warm daily lyrics ──────────────────────────────
    const today    = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    const dailyEntries = db.getDaily().filter(e => e.date === today || e.date === tomorrow);

    emit({ phase: "lyrics", current: 0, total: dailyEntries.length, message: "Ładowanie tekstów dziennych..." });
    for (let i = 0; i < dailyEntries.length; i++) {
      const entry = dailyEntries[i];
      try {
        const words = await genius.getWordArray(entry.songID);
        if (!words) {
          const prev = state.songHealth.get(entry.songID);
          if (prev) prev.hasLyrics = false;
          else state.songHealth.set(entry.songID, { title: `#${entry.songID}`, cover: null, hasLyrics: false, hasYoutube: false, hasAlbum: false, lastError: "no lyrics for daily", checkedAt: new Date().toISOString() });
        }
        emit({ phase: "lyrics", current: i + 1, total: dailyEntries.length, message: `Tekst: ${entry.date}` });
      } catch (e) {
        emit({ phase: "lyrics", current: i + 1, total: dailyEntries.length, message: `Błąd tekstu: ${entry.date}` });
      }
    }

    // ── Phase 3: fetch Genius metadata for all songs ────────────
    const eligible = allSongs.filter(s => !SKIP_PATTERNS.test(s.title));
    const BATCH = 5;
    const DELAY = 800;

    emit({ phase: "metadata", current: 0, total: eligible.length, message: "Pobieranie metadanych..." });
    for (let i = 0; i < eligible.length; i += BATCH) {
      const batch = eligible.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(s => genius.getSongById(s.id)));
      for (let j = 0; j < batch.length; j++) {
        const s = batch[j];
        const r = results[j];
        const info = r.status === "fulfilled" ? r.value : null;
        const errMsg = r.status === "rejected" ? r.reason?.message || "unknown" : (!info ? "no data" : null);
        state.songHealth.set(s.id, {
          title: s.title,
          cover: s.cover || null,
          hasLyrics: !!(info && info.lyrics),
          hasYoutube: !!(info && info.youtube),
          hasAlbum: !!(info && info.album),
          lastError: errMsg,
          checkedAt: new Date().toISOString(),
        });
      }
      const done = Math.min(i + BATCH, eligible.length);
      emit({ phase: "metadata", current: done, total: eligible.length, message: `Metadane: ${done}/${eligible.length}` });
      if (i + BATCH < eligible.length) await new Promise(r => setTimeout(r, DELAY));
    }

    // ── Phase 4: collect YouTube IDs ────────────────────────────
    const toDownload = [];
    for (const s of eligible) {
      const info = genius.getSongCacheEntry(s.id);
      if (info && info.youtube && !audio.exists(info.youtube) && !audio.isFailed(info.youtube)) {
        toDownload.push({ id: s.id, title: s.title, ytId: info.youtube });
      }
    }
    const alreadyCached = eligible.length - toDownload.length;

    // ── Phase 5: download ALL audio (blocking) ──────────────────
    const CONCURRENCY = 4;
    const DL_DELAY = 500;
    emit({ phase: "audio", current: 0, total: toDownload.length, message: "Pobieranie audio..." });
    for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
      await Promise.all(
        toDownload.slice(i, i + CONCURRENCY).map(s =>
          audio.download(s.ytId).catch(e => {
            console.error(`[WARM] Audio failed: ${s.title} (${s.ytId}):`, e.message);
          })
        )
      );
      const done = Math.min(i + CONCURRENCY, toDownload.length);
      emit({ phase: "audio", current: done, total: toDownload.length, message: `Audio: ${done}/${toDownload.length}` });
      if (i + CONCURRENCY < toDownload.length) await new Promise(r => setTimeout(r, DL_DELAY));
    }

    // ── Ready! Return so server can swap ────────────────────────
    state.otsochodziId = artistId;
    emit({ phase: "ready", current: 1, total: 1, message: "Serwer gotowy!" });
    return true;
  } catch (e) {
    console.error("[WARM] Startup warm-up failed:", e.message);
    emit({ phase: "error", message: e.message });
    return false;
  }
}

module.exports = { runWarmup };
