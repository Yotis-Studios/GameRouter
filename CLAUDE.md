# GameRouter

Raifu Wars game lobby and matchmaking server. Forked from MasterServer.

## Architecture

GameRouter is a Node.js Express HTTP API that orchestrates Raifu Wars game servers.
Game servers are separate Hemlock processes (using gn.hml) that handle real-time
WebSocket gameplay. Each game runs in its own isolated process.

### Components

- **GameRouter (this repo)** - HTTP API for game listing, hosting, PoW challenges.
  Forks one Hemlock process per game, communicates via stdin/stdout NDJSON.
- **shikikan.hml (separate repo, expected at `../RaifuWarsServer`)** - Hemlock game server using gn.hml.
  Handles WebSocket connections, game logic, turns, maps, etc.
- **nginx (optional)** - Reverse proxies WebSocket connections so all traffic
  goes over port 80. Configured via `nginx` option in config.

### IPC Protocol

Communication between GameRouter and game servers uses newline-delimited JSON
over stdin (commands to game) and stdout (events from game).

Game server stdout events:
```json
{"event":"port","data":12345}
{"event":"players","data":3}
{"event":"name","data":"My Lobby"}
{"event":"isStarted","data":1}
{"event":"mapHash","data":"abc123..."}
{"event":"mapName","data":"Desert Map"}
{"event":"numPlayers","data":4}
{"event":"locked","data":1}
{"event":"gameSpeed","data":2}
{"event":"gameLength","data":1}
{"event":"spectators","data":true}
```

### Secrets

Secrets are loaded from environment variables, never committed to the repo:
- `ACCESS_KEY` - PoW challenge salt (combined with version string)
- `DISCORD_WEBHOOK` - Optional Discord webhook URL for notifications

Non-sensitive config lives in `config.json` (gitignored, create from `config.example.json`).

## Development

```bash
cp config.example.json config.json  # edit as needed
npm install
ACCESS_KEY=your_key node server.js
```

## Files

- `server.js` - Express HTTP server, routes, rate limiting, SQLite metadata
- `Game.js` - Game process lifecycle, spawns Hemlock, parses NDJSON events
- `challenge.js` - Proof-of-work challenge generation and verification (MD5)
- `config.example.json` - Template config (version, port, collectMetadata)
