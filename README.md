# Cotsozanuta

A word-guessing game based on [Otsochodzi](https://genius.com/artists/Otsochodzi) lyrics. Given a single word from a song, guess which track it's from.

## How It Works

The game reveals one word at a time from an Otsochodzi song's lyrics. Type a song title into the autocomplete field and submit your guess. You can request more words (hints) if needed — the fewer hints you use, the higher your score.

Two modes are available:
- **Daily** — one fixed song per day, shared by all players
- **Endless** — random song each round, play as many times as you want

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
PORT=3000  # optional, defaults to 3000
```

### Run

```bash
node .
```

The server starts on `http://localhost:3000`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/game/endless` | Get a random song for endless mode |
| `GET` | `/api/game/daily/:date` | Get the daily song for a given date (`YYYY-MM-DD`) |
| `GET` | `/api/lyrics?songId=&wordIndex=` | Get a specific word from a song's lyrics |
| `GET` | `/api/autocomplete/songs?query=` | Search song titles for autocomplete |
| `GET` | `/api/leaderboard` | Get top 20 scores |
| `POST` | `/api/leaderboard` | Submit a score `{ name, score }` |

## Project Structure

```
index.js          # Express server & game logic
utils/genius.js   # Genius API client with disk caching
daily.json        # Daily challenge schedule
leaderboard.json  # Persisted leaderboard scores
public/views/     # Frontend HTML
.cache/           # Auto-generated API response cache
```

## Caching

Song metadata and lyrics are cached to disk under `.cache/` to minimise Genius API requests. The cache is loaded on startup and updated on first fetch.

## Adding Daily Challenges

Add entries to `daily.json`:

```json
[
  { "date": "2026-05-30", "songID": 12345678, "wordIndex": 0 }
]
```

`songID` is the Genius song ID. `wordIndex` is the index of the starting word in the lyrics.
