// Shared mutable server state. A single object reference imported everywhere,
// so writes by the warm-up routine are visible to all route handlers.
//
//   otsochodziId — stays null until warm-up resolves the artist; game endpoints
//                  return 503 until then.
//   cachedAlbums — lazily populated by /api/albums; reset on restart and whenever
//                  the background warm-up finishes caching new album data.
module.exports = {
    otsochodziId: null,
    cachedAlbums: null,
    // Per-song health: Map<songId, { title, hasLyrics, hasDeezer, lastError, checkedAt }>
    // Populated during warmup and on-demand fetches.
    songHealth: new Map(),
};
