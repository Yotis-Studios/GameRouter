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
{"event":"gameMode","data":2}
```

Only the events in `FIELDS` (Game.js) are read; anything else is logged and dropped. Platform
events (P3): `public`, `humans`, `bots`, `joinable`, and
`{"event":"join","data":{"sub":"g:12","name":"Ace"}}` / `{"event":"leave","data":{"sub":"g:12"}}`
with the sub the server verified from the player token.

Commands to the game server on stdin, one JSON line each (shikikan learns them in P4):
```json
{"cmd":"kick","data":{"sub":"g:12","reason":"..."}}
{"cmd":"mute","data":{"sub":"g:12"}}
{"cmd":"announce","data":{"text":"..."}}
{"cmd":"close","data":{"reason":"..."}}
{"cmd":"reserve","data":{"ticket":"<32 hex>","sub":"g:12","name":"Ace","expires":1793480000000}}
{"cmd":"jwks","data":{"keys":[...]}}
```
Every child also gets `ROUTER_GAME`, `ROUTER_MATCH_ID`, `ROUTER_PUBLIC` (1 for a Quick Play
match, which fills empty seats with bots) and `ROUTER_JWKS` (the player token key set, which the
server verifies tokens with; `jwks` sends a new one) in its environment.

`{"event":"report","data":{reporter, reporter_name, reported, reported_name, reason, lines}}` is a
player's report with the chat lines the server kept; the router keeps the last 50 per match in the
admin API until the account service takes them (P5).

### Secrets

Secrets are loaded from environment variables, never committed to the repo:
- `ACCESS_KEY` - PoW challenge salt (combined with version string)
- `DISCORD_WEBHOOK` - Optional Discord webhook URL for notifications

Non-sensitive config lives in `config.json` (gitignored, create from `config.example.json`).
Which games are served, with their version gates and launch commands, lives in `games.json`
(gitignored, create from `games.example.json`) or `$GAMES_JSON`; without either the router
serves one game from `config.json`. Every endpoint takes `game=<id>`; none means the default
game, an unknown one is 404, and lobbies never list or resolve across games.

## Development

```bash
cp config.example.json config.json  # edit as needed
npm install
ACCESS_KEY=your_key node server.js
```

## Files

- `server.js` - Express HTTP server, routes, rate limiting, SQLite metadata
- `games.js` - The game descriptors: which games are served, each one's version gate and server launch command (`games.json`, `$GAMES_JSON`, or one game from `config.json`)
- `Game.js` - Game process lifecycle, spawns the descriptor's server, parses NDJSON events
- `challenge.js` - Proof-of-work challenge generation and verification (MD5)
- `config.js` - Every setting: config.json (optional) with the environment on top
- `playerTokens.js` - Yotis Online player tokens checked against the account service's JWKS
- `bans.js` - The ban list from the account service, refreshed every 30 s
- `config.example.json` - Template config (version, port, collectMetadata)
- `test/` - `npm test`: the real router against stub game servers and a stub account service
- `tools/game-release.sh` - Deploys a game server as a new release behind the serverDir link

## Deploying a game server: never restart the router for it

Use `tools/game-release.sh` (README, "Deploying a game server"). A game's serverDir is a link to
the current release; `deploy` installs a release (packed with its dependencies), preflights it,
and switches the link. Running matches keep the release they started in (Game.js resolves the
link per match), so there is nothing to wait for and no lobby to check first.

- Never overwrite, delete or `mv` a release by hand: a live match may be running in it.
  `status` shows which are live; `prune` deletes only releases nobody runs.
- Never install dependencies on a production host: pack them into the release on a build box.
- A failed preflight leaves the link where it was. Fix the release, deploy it under a new name.
- `rollback` switches back to the previous release, the same way.
- Restart the router only for a router, `games.json` or environment change, and only while
  `/games` is empty: every match is a child process of the router and dies with it.
