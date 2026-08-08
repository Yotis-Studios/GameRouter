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
| POST | `/challenge` | Generates a proof-of-work challenge for the caller |
| POST | `/games` | Hosts a new game (requires PoW solution in body) |

### Hosting a game

1. `POST /challenge` to get a challenge number
2. Find a `solution` such that `MD5(ACCESS_KEY + version + challenge + solution)` starts with `000`
3. `POST /games` with body `pow=<solution>&host=<name>&name=<lobby_name>`
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
