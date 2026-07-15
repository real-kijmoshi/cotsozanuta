# Cotsozanuta

A lyrics-based word-guessing game built around [Otsochodzi](https://genius.com/artists/Otsochodzi). A single word from a song is revealed — guess the track title. The fewer hints you need, the higher your score.

## Game Modes

| Mode | Description |
|------|-------------|
| **Daily** | One fixed song per day, shared by all players. Come back tomorrow for a new challenge. |
| **Endless** | Random song each round. Play as many times as you want, optionally filtered by album. |
| **Ranked** | 60-second timed blitz — guess as many songs as possible, then post your score to the leaderboard. |
| **Audio** | Guess the song from a Deezer preview snippet instead of lyrics. Available in endless and daily modes. |

Ranked sub-modes: **Sprint 60s**, **Sprint 180s**, **Survival** (per-song timer).

## Tech Stack

- **Runtime:** Node.js ≥ 18
- **Server:** Express 5 with Helmet (CSP), compression, and per-route rate limiting
- **Database:** SQLite via `better-sqlite3` (daily schedule, stats, leaderboard, game plays, toasts)
- **Lyrics:** Genius API with disk-based caching (`db/cache/`)
- **Audio:** Deezer's public search API for 30s preview MP3s, played directly from Deezer's CDN (no server-side download/caching)
- **Frontend:** Vanilla HTML/CSS/JS (no build step)

## Setup

### Prerequisites

- Node.js ≥ 18
- A [Genius API](https://genius.com/api-clients) access token

### Installation

```bash
npm install
```

### Environment

Create a `.env` file in the project root:

```env
GENIUS_ACCESS_TOKEN=your_token_here
ADMIN_PASSWORD=your_admin_password_here
ADMIN_JWT_SECRET=optional_jwt_secret  # defaults to ADMIN_PASSWORD
ADMIN_JWT_EXPIRES=12h                  # token lifetime
PORT=3000                              # optional, defaults to 3000
```

### Run

```bash
node .
```

The server warms up (fetches song metadata, caches audio) then starts on `http://localhost:3000`.

## API Reference

### Game

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/game/endless` | Random song for endless mode. Optional `?albums=id1,id2` filter; `?sessionId=` for ranked; `?audio=1` for audio mode. |
| `GET` | `/api/game/audio/endless` | Random song for audio endless mode. |
| `GET` | `/api/game/daily/:date` | Daily song for the given date (`YYYY-MM-DD`). Auto-generates today's entry if none is scheduled. |
| `GET` | `/api/game/result` | Record game result `{ mode, outcome, wordsRevealed, durationMs }`. |
| `GET` | `/api/lyrics?songId=&wordIndex=` | Reveal a specific word from a song's lyrics. |
| `GET` | `/api/autocomplete/songs?query=` | Song title suggestions for the guess input. |
| `GET` | `/api/albums` | List all known albums. |
| `GET` | `/api/toasts` | Active announcement toasts (public). |

### Stats

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/daily-stats/:date` | Aggregated stats for a daily game date. |
| `POST` | `/api/daily-stats/:date` | Submit a result `{ wordsRevealed, outcome }`. |

### Ranked

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ranked/start` | Start a session `{ mode }` → `{ sessionId }`. |
| `GET` | `/api/ranked/song?sessionId=` | Next song for an active ranked session. |
| `POST` | `/api/ranked/correct` | Record a correct guess `{ sessionId, songId }` → `{ score }`. |

### Leaderboard

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/leaderboard` | Ranked scores. Optional `?mode=sprint60\|sprint180\|survival`. |
| `POST` | `/api/leaderboard` | Submit a score `{ name, sessionId }` → `{ rank }`. |

### Admin

Admin routes require a JWT bearer token in the `Authorization: Bearer <token>` header. For convenience the legacy `x-admin-password` header is still accepted.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/admin/login` | Verify admin password `{ password }` and return `{ token }`. |
| `GET` | `/api/admin/songs` | List all cached songs. |
| `GET` | `/api/admin/lyrics/:songId` | Fetch lyrics for a song. |
| `GET` | `/api/admin/daily` | List all daily challenge entries. |
| `POST` | `/api/admin/daily` | Add/update a daily entry `{ date, songID, wordIndex }`. |
| `DELETE` | `/api/admin/daily/:date` | Remove a daily entry by date. |
| `GET` | `/api/admin/stats-overview` | Aggregated stats across all dates. |
| `GET` | `/api/admin/ranked-overview` | Ranked mode stats. Optional `?mode=` param. |
| `GET` | `/api/admin/users-overview` | User analytics (DAU, new users, engagement). |
| `GET` | `/api/admin/song-health` | Per-song health status (lyrics, audio, errors). |
| `GET` | `/api/admin/toasts` | List all announcement toasts. |
| `POST` | `/api/admin/toasts` | Create a toast `{ title, subtitle, icon, ... }`. |
| `PUT` | `/api/admin/toasts/:id` | Update a toast. |
| `DELETE` | `/api/admin/toasts/:id` | Delete a toast. |

## Admin Panel

`/admin` — Full management interface:

- **Daily editor**: date picker, song search with autocomplete, lyrics viewer with word index selection, save/delete
- **Stats**: KPIs, daily/monthly charts, guess distribution, audio vs text breakdown
- **Ranked mode**: sub-mode stats, monthly charts, top 10 leaderboard
- **Song health**: per-song status table (lyrics, audio, errors) with filters
- **Announcements (toasts)**: create, edit, delete scheduled announcements with full customization (colors, position, duration, date range, once-per-user)
- **Schedule table**: all daily entries with cover art, clickable to pre-fill editor
- Dedicated stats page at `/admin/stats`

## Auto-Daily

When no manual daily entry is scheduled for today, the server automatically picks a song deterministically from the artist's major albums. The selection is seeded from the date string so the same date always maps to the same song, and the result is persisted to the database. Past dates without entries return 404.

## Project Structure

```
index.js                    # App entry point, middleware, route mounting, startup
src/
  config.js                 # Central config, skip patterns
  state.js                  # Shared mutable state (artist ID, cached albums, song health)
  songPicker.js             # Song selection + auto-daily fallback
  warmup.js                 # Startup warmup sequence
  warmupServer.js           # SSE warmup progress page
  rankedSessions.js         # Ranked session store and cleanup
  rateLimiters.js           # Per-route rate limiters
  geo.js                    # Country detection from CDN headers
  middleware/
    adminAuth.js            # JWT + legacy admin auth
  routes/
    pages.js                # Static HTML page routes
    admin.js                # Admin API endpoints
    game.js                 # Game API (endless, audio, daily, result)
    ranked.js               # Ranked session API
    content.js              # Lyrics, autocomplete, discography, albums, toasts
    stats.js                # Public daily stats API
    leaderboard.js          # Public leaderboard API
utils/
  genius.js                 # Genius API client with disk caching (incl. Deezer preview matching)
  db.js                     # SQLite database, schema, migrations, prepared statements
db/
  app.db                    # SQLite database file
  cache/                    # Auto-generated Genius API + audio cache (gitignored)
public/
  views/                    # Frontend HTML pages
  images/                   # Static image assets
```

## Toast / Announcement System

The admin can create scheduled announcements that display as toast notifications on the main page. Each toast supports:

- **Title** and optional **subtitle**
- **Icon** (emoji)
- **Colors**: background, border, accent (left stripe)
- **Position**: top/bottom × left/center/right
- **Duration**: auto-hide after N ms (0 = manual close only)
- **Date range**: optional start/end dates for scheduling
- **Once per user**: show only once per browser (localStorage)
- **Enabled/disabled** toggle

Active toasts are fetched from `/api/toasts` on page load. Multiple toasts are staggered with delays.

## Caching

Song metadata and lyrics are cached to disk under `db/cache/` to minimise Genius API requests. The cache is populated on startup and updated on first fetch of each song. Audio snippets are cached under `db/cache/audio/`.
