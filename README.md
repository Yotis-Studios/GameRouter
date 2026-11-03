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
| POST | `/quickplay` | A seat in a public match, for a Yotis Online player (see below) |

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

## Yotis Online

The platform features (yo-account-api `docs/PLATFORM.md`, phase P3) are off until configured,
and every existing client works unchanged either way.

| Setting | |
|---------|--|
| `ACCOUNT_API_URL` | The account service. Player tokens are checked against its public key (`/api/.well-known/jwks`), offline. Turns on Quick Play. |
| `SERVICE_KEY` | Shared with the account service. Turns on the ban list (`/internal/bans`, refreshed every `BAN_REFRESH_MS`, 30 s) and is required on every admin API request. |
| `ADMIN_PORT`, `ADMIN_HOST` | The admin API's own listener; `ADMIN_HOST` defaults to `127.0.0.1`. Never put it behind the public proxy. |

The listing gains `id` (the match id), `public`, `humans`, `bots` and `joinable`; every old
field is unchanged. Each match is given the player token key set (`ROUTER_JWKS`) so its server
verifies players itself, and is sent the new set when the account service rotates it. Players'
reports (with the chat lines the server kept) are passed on to the account service
(`POST /internal/reports`, named by `ROUTER_NAME`, default `main`) and show in the admin API's
match details with `forwarded` saying whether they arrived.

### Quick Play

A game offers it when its descriptor says `"quickplay": true` (or `{"seats": n}`, the seats a
new match has until its server reports `numPlayers`). `POST /quickplay` with the player token in
`Authorization` (raw or `Bearer`) and `game=<id>` answers
`{match, game, code, port, path?, ticket, expires}`. The router picks the public match with the
most humans and a free seat (a started one only if its server reports `joinable`), or starts a
new public match, and holds the seat for 30 seconds. The client connects and presents the ticket
with its token; the server seats only that player on it. Guests are welcome; anyone banned from
public play (in the router's ban list or the token's `restrict` claim) gets 403. Ten requests a
minute per player.

### Bans

A ban on `all` kicks the player from any match and refuses Quick Play; `public_play` does the same
for public matches only; `chat` mutes them. Checked when a server reports a join and for everyone
seated after every refresh. A failed refresh keeps the last list.

### Admin API

On `ADMIN_HOST:ADMIN_PORT`, every request with `X-Service-Key` (anything else is 404):

| Method | Endpoint | |
|--------|----------|--|
| GET | `/admin/matches[?game=]` | Every live match with its roster, reservations, process and uptime |
| GET | `/admin/matches/:id` | One match |
| POST | `/admin/matches/:id/kick` | `{sub, reason}` |
| POST | `/admin/matches/:id/announce` | `{text}` |
| POST | `/admin/matches/:id/close` | `{reason}`; terminated if it has not ended 10 s later |
| POST | `/admin/bans/refresh` | Fetch the ban list now |

### Testing

`npm test` runs the real router in a child process against stub game servers
(`test/stub-game.js`) and a stub account service, on loopback. Nothing is written next to the
router.

## Deploying a game server (no router restart)

A game server deploys by switching a link, not by restarting the router. A game's `serverDir`
(or `GAME_SERVER_DIR`) is a symlink to the current release, with the releases beside it:

```
/home/server/shikikan            -> shikikan.releases/v0.3.4-09c5f44
/home/server/shikikan.releases/
    v0.3.3-5dbe7b7/              previous, kept for rollback
    v0.3.4-09c5f44/
    HISTORY                      every adopt, install, activate and prune, with who and when
```

The router resolves the link once per match, when it starts it, and the match runs in that
directory until it ends. The admin API's `release` field says which. So switching the link
changes what the **next** match runs: matches in progress finish on their own release, and the
router keeps running. A release is only deleted by `prune`, and never while a process is running
in it.

`tools/game-release.sh` does all of it on the router host, as root:

```bash
# from a dev machine: pack the release WITH its dependencies (nothing is installed on the host)
ssh build 'cd /tmp/rel && git -C ~/Projects/shikikan.hml archive HEAD | tar -x && hpm install && tar -czf - .' \
  | ssh root@host /path/to/GameRouter/tools/game-release.sh deploy /home/server/shikikan v0.3.4-09c5f44 --owner server

game-release.sh status   /home/server/shikikan                # releases, which is current, which are live
game-release.sh rollback /home/server/shikikan                # back to the previous release
game-release.sh prune    /home/server/shikikan --keep 3       # delete old releases nobody runs
```

`deploy` = `install` (unpack stdin into a new release; names are never reused) + `preflight`
(start it as the router would, `hemlock server.hml` or `--start`, with `--env` for a port range,
and require the `{"event":"port"}` line and that port listening) + `activate` (an atomic switch
of the link). A release that fails preflight is installed but not activated. The first deploy on
a `serverDir` that is still a plain directory adopts it as `adopted-<timestamp>`; a move keeps the
inode, so matches running from it carry on.

A game whose server imports files beside it (a Ganbatte game's `server/` imports `../rules/`) is
released as the whole game directory, with `--cwd server` so preflight starts where the router
does; its serverDir stays `<link>/server`, which resolves through the link into the same release.
Install strips group and other write permission from every file (a release packed on Windows
arrives world-writable).

What still needs a router restart: a change to the **router** itself, `games.json`, or the
router's environment. Restart only while `/games` is empty: every match is a child of the router.

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
