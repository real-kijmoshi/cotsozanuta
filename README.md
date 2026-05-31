# Cotsozanuta

A word-guessing game based on [Otsochodzi](https://genius.com/artists/Otsochodzi) lyrics. Given a single word from a song, guess which track it's from.

## How It Works

The game reveals one word at a time from an Otsochodzi song's lyrics. Type a song title into the autocomplete field and submit your guess. You can request more words (hints) if needed — the fewer hints you use, the higher your score.

Three modes are available:
- **Daily** — one fixed song per day, shared by all players
- **Endless** — random song each round, play as many times as you want
- **Ranked** — 60-second timed blitz; guess as many songs as possible and submit to the leaderboard

## Setup

### Prerequisites

- Node.js
- A [Genius API](https://genius.com/api-clients) access token

### Installation

```bash
npm install
```

### Environment

Create a `.env` file in the project root:

```
GENIUS_ACCESS_TOKEN=your_token_here
ADMIN_PASSWORD=your_admin_password_here
PORT=3000  # optional, defaults to 3000
```

### Run

```bash
node .
```

The server starts on `http://localhost:3000`.

## API Endpoints

### Game

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/game/endless` | Get a random song for endless mode (optional `?albums=id1,id2` filter; optional `?sessionId=` for ranked) |
| `GET` | `/api/game/daily/:date` | Get the daily song for a given date (`YYYY-MM-DD`) |
| `GET` | `/api/lyrics?songId=&wordIndex=` | Get a specific word from a song's lyrics |
| `GET` | `/api/autocomplete/songs?query=` | Search song titles for autocomplete |
| `GET` | `/api/albums` | List all known albums |

### Stats

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/daily-stats/:date` | Get aggregated stats for a daily game date |
| `POST` | `/api/daily-stats/:date` | Submit a daily game result `{ wordsRevealed, outcome }` |

### Ranked

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ranked/start` | Start a 60-second ranked session → `{ sessionId }` |
| `GET` | `/api/ranked/song?sessionId=` | Get next song for an active ranked session |
| `POST` | `/api/ranked/correct` | Record a correct guess `{ sessionId, songId }` → `{ score }` |

### Leaderboard

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/leaderboard` | Get top 20 scores |
| `POST` | `/api/leaderboard` | Submit a ranked score `{ name, sessionId }` → `{ rank }` |

### Admin (requires `x-admin-password` header)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/admin/login` | Verify admin password `{ password }` |
| `GET` | `/api/admin/songs` | List all cached songs |
| `GET` | `/api/admin/lyrics/:songId` | Fetch lyrics for a song |
| `GET` | `/api/admin/daily` | List all daily challenge entries |
| `POST` | `/api/admin/daily` | Add/update a daily entry `{ date, songID, wordIndex }` |
| `DELETE` | `/api/admin/daily/:date` | Remove a daily entry by date |
| `GET` | `/api/admin/stats-overview` | Get aggregated stats across all dates |

## Project Structure

```
index.js          # Express server & all route handlers
utils/genius.js   # Genius API client with disk caching
utils/db.js       # SQLite-backed persistence (daily, leaderboard, stats)
db/daily.json     # Daily challenge schedule (source of truth)
db/cache/         # Auto-generated Genius API response cache (gitignored)
public/views/     # Frontend HTML
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
