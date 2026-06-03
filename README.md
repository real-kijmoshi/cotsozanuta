# Cotsozanuta

A lyrics-based word-guessing game built around [Otsochodzi](https://genius.com/artists/Otsochodzi). A single word from a song is revealed — guess the track title. The fewer hints you need, the higher your score.

## Game Modes

| Mode | Description |
|------|-------------|
| **Daily** | One fixed song per day, shared by all players. Come back tomorrow for a new challenge. |
| **Endless** | Random song each round. Play as many times as you want, optionally filtered by album. |
| **Ranked** | 60-second timed blitz — guess as many songs as possible, then post your score to the leaderboard. |

## Tech Stack

- **Runtime:** Node.js ≥ 18
- **Server:** Express 5 with Helmet (CSP), compression, and per-route rate limiting
- **Database:** SQLite via `better-sqlite3` (daily schedule, stats, leaderboard)
- **Lyrics:** Genius API with disk-based caching (`db/cache/`)
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
PORT=3000        # optional, defaults to 3000
```

### Run

```bash
node .
```

The server starts on `http://localhost:3000`.

## API Reference

### Game

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/game/endless` | Random song for endless mode. Optional `?albums=id1,id2` filter; optional `?sessionId=` to track ranked progress. |
| `GET` | `/api/game/daily/:date` | Daily song for the given date (`YYYY-MM-DD`). |
| `GET` | `/api/lyrics?songId=&wordIndex=` | Reveal a specific word from a song's lyrics. |
| `GET` | `/api/autocomplete/songs?query=` | Song title suggestions for the guess input. |
| `GET` | `/api/albums` | List all known albums. |

### Stats

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/daily-stats/:date` | Aggregated stats for a daily game date. |
| `POST` | `/api/daily-stats/:date` | Submit a result `{ wordsRevealed, outcome }`. |

### Ranked

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ranked/start` | Start a 60-second session → `{ sessionId }`. |
| `GET` | `/api/ranked/song?sessionId=` | Next song for an active ranked session. |
| `POST` | `/api/ranked/correct` | Record a correct guess `{ sessionId, songId }` → `{ score }`. The `songId` must match the last issued song. |

### Leaderboard

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/leaderboard` | Top 20 all-time ranked scores. |
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

## Project Structure

```
index.js            # Express server & all route handlers
utils/genius.js     # Genius API client with disk caching
utils/db.js         # SQLite-backed persistence (daily schedule, leaderboard, stats)
db/app.db           # SQLite database file
db/cache/           # Auto-generated Genius API response cache (gitignored)
public/views/       # Frontend HTML pages
public/images/      # Static image assets
```

## Caching

Song metadata and lyrics are cached to disk under `db/cache/` to minimise Genius API requests. The cache is populated on startup and updated on first fetch of each song.

## Adding Daily Challenges

Use the admin panel at `/admin`, or add entries directly to `db/daily.json`:

```json
[
  { "date": "2026-05-30", "songID": 12345678, "wordIndex": 0 }
]
```

`songID` is the Genius song ID. `wordIndex` is the index of the starting word in the lyrics.
