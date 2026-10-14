# GameRouter

HTTP matchmaking server for [Raifu Wars](https://store.steampowered.com/app/1685500/Raifu_Wars/). Lists available games, handles proof-of-work authentication, and spawns isolated game server processes.

## Setup

### Prerequisites

- Node.js 16+
- [Hemlock](https://github.com/hemlang/hemlock) 2.0+
- [shikikan.hml](https://github.com/Yotis-Studios/shikikan.hml) (Hemlock game server, expected at `../RaifuWarsServer` relative to this repo)
- nginx (optional, for reverse proxying game servers)

### Install

```bash
git clone https://github.com/Yotis-Studios/GameRouter.git
cd GameRouter
npm install
```

### Configure

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
    "version": "v1.13.2",
    "port": 42069,
    "collectMetadata": true
}
```

Set environment variables for secrets:

```bash
export ACCESS_KEY="your-proof-of-work-salt"
export DISCORD_WEBHOOK="https://discord.com/api/webhooks/..."  # optional
```

### Run

```bash
node server.js
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/version` | Returns the game version string |
| GET | `/games` | Lists active games sorted by newest first |
| GET | `/games/:code` | Resolves a short join code to one lobby |
| POST | `/challenge` | Generates a proof-of-work challenge for the caller |
| POST | `/games` | Hosts a new game (requires PoW solution in body) |

Every endpoint takes an optional `game=<id>` (a query parameter on GET, a body field on
POST) naming which of the configured games it is about. A request that names none means the
default game; one that names a game this router does not serve is answered `404`. Lobbies
are listed, resolved and joined only within their own game.

### Multiple games

One router can serve more than one game, each with its own version gate and its own server
launch command. Copy `games.example.json` to `games.json` (gitignored):

```json
{
    "raifuwars":       { "version": "v1.14.0", "default": true },
    "ganbatte-sample": { "version": "v0.1.0",
                         "serverDir": "../shikikan.hml",
                         "env": { "SHIKIKAN_REQUIRE_MAP": "0" } }
}
```

`version` is required. `serverDir`, `bin`, `args` and `env` default to `GAME_SERVER_DIR`
(then `../RaifuWarsServer`), `HEMLOCK_BIN` (then `hemlock`), `["server.hml"]` and nothing.
`GAMES_JSON` in the environment overrides the file, as a path or as inline JSON, so a test
run never writes on the host. With neither, the router serves one game from `config.json`'s
`version`, named by its `game` field (default `raifuwars`), exactly as before.

### Hosting a game

1. `POST /challenge` to get a challenge number
2. Find a `solution` such that `MD5(ACCESS_KEY + version + challenge + solution)` starts with `000`
3. `POST /games` with body `pow=<solution>&host=<name>&name=<lobby_name>` (and `&game=<id>` for a game other than the default)
4. Response is the game server port (or WebSocket path in nginx mode)

## nginx Reverse Proxy

To route all traffic through port 80 (recommended for players on mobile networks):

```nginx
server {
    listen 80;

    # GameRouter API
    location / {
        proxy_pass http://127.0.0.1:42069;
    }

    # Game server WebSocket connections
    location ~ ^/game/(\d+)$ {
        proxy_pass http://127.0.0.1:$1;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }
}
```

## Self-Hosting

GameRouter caps the number of concurrent games based on available system memory.
Each game server is an isolated Hemlock process with minimal overhead. A modest
VPS (2GB RAM) can comfortably run dozens of concurrent games.

## License

MIT
