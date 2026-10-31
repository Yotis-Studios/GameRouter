const os = require('os');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const express = require('express');
const app = express();

// ENV OVERRIDES FOR EVERY CONFIG VALUE, so nothing has to EDIT config.json to run this
// differently. That file is gitignored and holds the live deployment's values -- including the
// version string, which is an exact-match compatibility gate rather than a label. Anything that
// swaps it out and swaps it back leaves the box mis-set whenever it is killed rather than exited,
// which is precisely when nobody is watching.
//
// The test harness (RaifuWars tools/net-game.sh) did exactly that: copy config.json aside, write
// its own, restore it from a shell trap. A trap does not run on SIGKILL, and a cancelled run left
// this deployment reporting a version it does not serve.
//
// config.json stays the source of truth; the environment only overrides it. Both are read in
// config.js, which Game.js shares.
const config = require('./config');
const { version, port, nginx } = config;
let { collectMetadata } = config;

// In nginx mode, all requests arrive via the local reverse proxy, so trust
// its X-Forwarded-For header to recover the real client IP -- otherwise
// req.ip resolves to the proxy's own address for every request, collapsing
// rate limiting and the per-IP PoW challenge map onto a single shared
// bucket. Only trust the loopback hop (not an arbitrary chain), since
// nginx is expected to run on the same host per the documented setup.
// Outside nginx mode, leave Express's default (don't trust proxy headers
// at all) so a client can't spoof its IP via X-Forwarded-For directly.
//
// TRUST_LOOPBACK_PROXY=1 does the same without nginx mode: lobbies are still handed out as bare
// ports (desktop clients dial them directly, as before), while requests that arrive through a
// local reverse proxy -- a browser build, which may only call https on the site's own origin --
// keep their client's address. Express trusts the header only when the immediate peer is
// loopback, so a client dialling the router directly still cannot spoof its IP.
const { trustLoopbackProxy } = config;
if (trustLoopbackProxy) {
  app.set('trust proxy', 'loopback');
}

const accessKey = process.env.ACCESS_KEY;
const discordHook = process.env.DISCORD_WEBHOOK;

const { generateChallenge, testSolution } = require('./challenge.js');
const { generateCode, normalise: normaliseCode } = require('./code.js');
const { loadGames, resolveGame } = require('./games.js');
const { createPlayerTokens } = require('./playerTokens.js');
const { BanCache } = require('./bans.js');
const Game = require('./Game');

// YOTIS ONLINE (P3): player tokens for Quick Play, and the ban list. Both off unless
// ACCOUNT_API_URL (and, for bans, SERVICE_KEY) is set -- see config.js.
const playerTokens = createPlayerTokens(config.accountApi);
const bans = new BanCache({ accountApi: config.accountApi, serviceKey: config.serviceKey, refreshMs: config.banRefreshMs });

// The key set every match verifies its players' tokens with (shikikan, P4): given to each match
// as it is spawned, sent to the live ones when it changes, and looked at every five minutes so a
// rotation reaches them without waiting for a Quick Play request.
async function currentKeys() {
  return playerTokens ? playerTokens.keys(false) : null;
}
if (playerTokens) {
  playerTokens.onChange((keys) => {
    for (const game of allGames) game.send('jwks', keys);
  });
  setInterval(() => playerTokens.keys(false), 300000).unref();
}

// WHICH GAMES THIS ROUTER SERVES -- see games.js. With no games.json and no $GAMES_JSON this
// is one game built from the version above, named by config.json's "game" (default
// "raifuwars"), and every route behaves exactly as it did before descriptors existed.
const catalogue = loadGames({ version, game: config.game });

// 404 for a request that names a game this router does not serve. Answering as the default
// instead would list one game's lobbies to another game's client, which is the one thing the
// descriptors exist to prevent.
function gameFor(req, res) {
  const named = req.query.game !== undefined ? req.query.game : (req.body ? req.body.game : undefined);
  const game = resolveGame(catalogue, named);
  if (!game) {
    res.status(404).send('No such game.');
    console.error(`${req.ip} asked for game "${named}", which this router does not serve`);
  }
  return game;
}

const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('gamedata.db', (err) => {
  if (err) {
    console.error('Failed to open gamedata database. Metadata will not be collected.');
    console.error(err.message);
    collectMetadata = false;
  } else {
    console.log('Connected to the gamedata database.');
  }
});

// THE SCHEMA, which nothing created. MasterServer's gamedata.db shipped with these tables
// already in it; GameRouter opens a fresh file, so on its first deploy every hosted lobby
// logged `SQLITE_ERROR: no such table: session` and no metadata was collected at all.
// Copied verbatim from MasterServer's database so the two stay queryable the same way.
// `serialize` keeps these ahead of the first INSERT, which can arrive as soon as we listen.
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS map (
    hash VARCHAR(40) NOT NULL PRIMARY KEY,
    name VARCHAR(100)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS session (
    id        INTEGER NOT NULL PRIMARY KEY,
    timestamp DATETIME,
    length    INTEGER,
    ip        VARCHAR(100),
    port      INTEGER,
    name      VARCHAR(100),
    locked    BOOLEAN,
    host      VARCHAR(100)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS match (
    id         INTEGER NOT NULL PRIMARY KEY,
    session_id INTEGER,
    players    INTEGER,
    speed      INTEGER,
    length     INTEGER,
    map        VARCHAR(40),
    FOREIGN KEY (session_id) REFERENCES session(id),
    FOREIGN KEY (map) REFERENCES map(hash)
  )`, (err) => {
    if (err) console.error('Failed to create the gamedata schema: ' + err.message);
  });
});

const { Webhook } = require('discord-webhook-node');
const discord = discordHook ? new Webhook(discordHook) : null;

// Limit to 100 requests every 10 seconds
const rateLimit = require("express-rate-limit");
app.use(rateLimit({
  windowMs: 10000,
  max: 100
}));
// use urlencoded format for body messages
app.use(bodyParser.urlencoded({
  extended: false,
  limit: 256,
  parameterLimit: 16
}));

// Map of IP -> generated challeges
const challenges = {};
// Map of port number -> raifu wars game server
const games = {};
// Map of join code -> raifu wars game server. Separate from `games` rather than a field scan,
// because a lookup by code is the whole point and scanning would make it O(games) per request
// on an endpoint anybody can call. Entries are added when a game is created and removed when
// it exits, so a code is never reachable after its lobby is gone -- and, more importantly,
// never reused while it is alive.
const codes = {};
// All games from spawn to exit, including ones still starting up and not
// yet in `games` (which only gets a port-keyed entry once the child
// process reports its port). Used for the per-IP cap below so a burst of
// requests can't all pass the check before any of them has a port yet.
const allGames = [];

// Max concurrent games a single IP may host. Without this, one actor can
// keep hosting games until the whole server hits its memory-based capacity
// limit below, denying service to everyone else.
const MAX_GAMES_PER_IP = 3;

// How long a fetched challenge stays valid before it must be re-requested.
// Also bounds how long an unused challenge lingers in memory.
const CHALLENGE_TTL_MS = 60000;

// Periodically clear out challenges nobody redeemed, so an attacker can't
// grow `challenges` unboundedly by hitting /challenge from many distinct
// source IPs and never following up with /games.
setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(challenges)) {
    if (challenges[ip] && challenges[ip].expires <= now) {
      delete challenges[ip];
    }
  }
}, CHALLENGE_TTL_MS).unref();

// Quick Play matches are the router's, not the player's who happened to start one, so they do
// not count against that player's hosting limit.
function countGamesForIp(ip) {
  return allGames.filter((g) => g.ip === ip && !g.quickPlay).length;
}

function maxGames() {
  return Math.floor(os.totalmem() / 50000000) - 5;
}

// A BANNED PLAYER IN A LIVE MATCH is kicked (banned from playing, or from public play in a
// public match) or muted (banned from chat). Checked when the server reports a join, and for
// everyone seated whenever the ban list is refreshed.
function enforceBans(game, sub) {
  if (!bans.enabled) return;
  if (!bans.mayPlay(sub, game.game, game.public)) {
    console.log(`(${game.port}): kicking ${sub}, who is banned`);
    game.kick(sub, 'You are banned from this match.');
  } else if (!bans.mayChat(sub, game.game)) {
    game.mute(sub);
  }
}
bans.onUpdate(() => {
  for (const game of allGames) for (const sub of game.roster.keys()) enforceBans(game, sub);
});

// EVERYTHING A MATCH NEEDS FROM SPAWN TO EXIT, whoever started it: its join code, its place in
// the lists, ban checks, and the metadata rows. POST /games and POST /quickplay each add only
// how they answer their own request.
function track(newGame) {
  // Minted before the game reports a port, so the code exists for as long as the game does and
  // is reserved against every other live game from the moment there is something to reserve it
  // for. GET /games/:code refuses to resolve it until the port arrives.
  newGame.code = generateCode(codes);
  if (newGame.code) codes[newGame.code] = newGame;
  allGames.push(newGame);
  newGame.on('join', (sub) => enforceBans(newGame, sub));
  newGame.on('port', (port) => {
    games[port] = newGame;
    if (collectMetadata) db.run('INSERT INTO session (port, host, name, timestamp, ip) VALUES (?, ?, ?, ?, ?)', [port, newGame.host, newGame.name, newGame.timestamp, newGame.ip], function(err) {
      if (err) {
        console.error('Failed to insert session into database.');
        console.error(err.message);
      } else {
        newGame.db_id = this.lastID;
      }
    });
    if (discord != null) discord.send(`**${newGame.host}** started a game for ${newGame.game} ${newGame.descriptor.version}`);
  });
  newGame.on('start', () => {
    // insert match into database
    if (collectMetadata && newGame.db_id != null) db.run('INSERT INTO match (session_id, players, speed, length, map) VALUES (?, ?, ?, ?, ?)', [newGame.db_id, newGame.players, newGame.gameSpeed, newGame.gameLength, newGame.mapHash], function(err) {
      if (err) {
        console.error('Failed to insert match into database.');
        console.error(err.message);
      }
    });
    // insert map into database; duplicates are expected, so errors are ignored
    if (collectMetadata) db.run('INSERT INTO map (hash, name) VALUES (?, ?)', [newGame.mapHash, newGame.mapName], () => {});
  });
  newGame.on('exit', (port) => {
    if (port !== '?' && games[port] === newGame) delete games[port];
    // Free the code with the game, not with the port. A game that dies before ever reporting
    // one still holds a code, and leaving it behind would leak an entry per failed spawn and
    // slowly poison the space that generateCode draws from.
    if (newGame.code) delete codes[newGame.code];
    const idx = allGames.indexOf(newGame);
    if (idx !== -1) allGames.splice(idx, 1);
    // get game length in seconds
    const gameLength = Math.floor((Date.now() - newGame.timestamp) / 1000);
    // update session in database
    if (collectMetadata && newGame.db_id != null) db.run('UPDATE session SET name = ?, locked = ?, length = ? WHERE id = ?', [newGame.name, newGame.locked, gameLength, newGame.db_id], function(err) {
      if (err) {
        console.error('Failed to update session in database.');
        console.error(err.message);
      }
    });
  });
}

// Where a client connects: the port, and in nginx mode the path it must use instead.
function connectInfo(game) {
  return nginx ? `/game/${game.port}` : game.port.toString();
}

// The version is PER GAME now: `?game=<id>` asks for that game's, nothing asks for the
// default's, which is what every client before descriptors asked for.
app.get('/version', (req, res) => {
  const game = gameFor(req, res);
  if (!game) return;
  res.status(200).send(game.version);
});

// Return joinable games sorted by timestamp
app.get('/games', (req, res) => {
  const game = gameFor(req, res);
  if (!game) return;
  // ONLY THIS GAME'S LOBBIES. A client never sees a lobby it could not join, and a client
  // that names no game sees the default game's, as it always did.
  const gameList = Object.keys(games)
    // .filter(port => games[port].canJoin())
    .filter(port => games[port].game === game.id)
    .map(port => {
      return games[port].getInfo();
    }).sort((a, b) => {
      return b.timestamp - a.timestamp;
    });
  res.status(200).send(gameList);
});

// Resolve a join code to one game.
//
// A SHORTCUT, NOT A SECRET. Every lobby is in GET /games and stays there; the code only saves
// a player hunting for their friend's row in a list that is sorted by age and holds everybody
// else's games too. So enumerating this endpoint reveals nothing /games does not already hand
// over in one request, and it does not need to resist being guessed.
//
// It is still covered by the global rate limiter above (100 requests per 10 seconds per IP),
// which is what stops it being a cheap way to make the router work. That limiter already
// existed and applies to every route -- worth saying because a limiter added to this endpoint
// alone would imply the others were considered and deliberately left open.
//
// Declared after GET /games so the exact path keeps winning; Express would match them in that
// order anyway, but the two are one character apart and the order is load-bearing.
app.get('/games/:code', (req, res) => {
  const which = gameFor(req, res);
  if (!which) return;
  const code = normaliseCode(req.params.code);
  const game = code ? codes[code] : undefined;

  // A game with no port yet has been spawned but has not reported where it is listening, so
  // there is nothing to connect to. Reporting it as absent rather than as an error is right:
  // from the player's side it is a code that is not ready, and the answer is to try again.
  //
  // Another game's code is absent too, not forbidden: a code is a shortcut into THIS game's
  // list, and a lobby that list would never show is one this client cannot have been told.
  if (!game || game.port === '?' || game.game !== which.id) {
    res.status(404).send('No game with that code.');
    return;
  }

  res.status(200).send(game.getInfo());
});

// generate challenge for this ip address
app.post('/challenge', (req, res) => {
  const challenge = generateChallenge();
  const ip = req.ip;
  challenges[ip] = { value: challenge, expires: Date.now() + CHALLENGE_TTL_MS };
  res.send(challenge);
});

// host a raifu wars game
app.post('/games', async (req, res) => {
  if (!req.body) {
    res.status(400);
    res.send('Body required.');
    console.error(req.ip + " did not provide body");
    return;
  }
  // Which game to spawn, before the proof of work is checked: the constant is per game.
  const which = gameFor(req, res);
  if (!which) return;
  // Before every check below, not between them and the spawn: from here to track() nothing
  // waits, so a burst cannot all pass the per-IP and capacity checks at once.
  const jwks = await currentKeys();
  // Check the user's proof of work before hosting new game
  const pow = req.body.pow;
  if (pow) {
    const stored = challenges[req.ip];
    const challenge = stored && stored.expires > Date.now() ? stored.value : undefined;
    delete challenges[req.ip];
    const challengeConstant = accessKey + which.version;
    if (!testSolution(challengeConstant, challenge, pow)) {
      res.status(401);
      res.send('Authentication failed.');
      console.error(req.ip + " failed POW");
      return;
    }
  } else {
    res.status(417);
    res.send('Invalid request.');
    console.error(req.ip + " did not provide POW");
    return;
  }

  if (countGamesForIp(req.ip) >= MAX_GAMES_PER_IP) {
    res.status(429);
    res.send('You already have the maximum number of games running.');
    console.error(req.ip + ' rejected. Already at per-IP game limit.');
    return;
  }

  const numGames = allGames.length;
  if (numGames >= maxGames()) {
    res.status(503);
    res.send('Server is at capacity. Please try again later.');
    console.error(req.ip + ' rejected. Out of system resources!');
    console.warn('Reached max number of games (' + maxGames() + ')!');
    return;
  }

  console.log(`Starting a ${which.id} game for ${req.ip} (${numGames+1}/${maxGames()})`);

  const host = req.body.host;// : 'Unknown';
  const name = req.body.name;// : 'Raifu Wars Match';
  const newGame = new Game(name, host, req.ip, which, { jwks });
  track(newGame);
  // The HTTP response is normally sent from the 'port' handler below. If the
  // game process exits before ever reporting a port (e.g. it crashed, or
  // picked an already-bound port), nothing would otherwise respond to this
  // request at all -- the caller's connection would just hang forever.
  let responded = false;
  newGame.on('port', () => {
    responded = true;
    res.status(200).send(connectInfo(newGame));
  });
  newGame.on('exit', () => {
    if (!responded) {
      responded = true;
      res.status(502).send('Game server failed to start.');
    }
  });
});

// QUICK PLAY: a seat in a public match of this game, for any Yotis Online player, guests
// included.
//
//   POST /quickplay   Authorization: <player token> (raw or Bearer)   body: game=<id> (or ?game=)
//   200 {match, game, code, port, path?, ticket, expires}
//
// The router picks the public match with the most humans that still has a seat (a match under
// way counts when its server says it is joinable, so players take bots' seats), or starts one.
// It holds the seat for QUICKPLAY_HOLD_MS and tells the match's server who the ticket is for;
// the client connects to the port (or path) and presents the ticket with its player token, and
// the server seats only that player on it (shikikan, P4).
//
// A game offers Quick Play only when its descriptor says `quickplay` (games.js). No proof of
// work: a verified player token is the cost, with a limit per player on top, and a new match is
// started only when no public match has room.
const QUICKPLAY_HOLD_MS = 30000;
const QUICKPLAY_PER_MINUTE = 10;
const quickPlayRecent = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [sub, times] of quickPlayRecent) {
    const kept = times.filter((t) => t > cutoff);
    if (kept.length) quickPlayRecent.set(sub, kept); else quickPlayRecent.delete(sub);
  }
}, 60000).unref();

// The scopes a token says are in force for `gameId` (its `restrict` claim, "scope" or
// "scope@game"), from when it was made.
function tokenRestricts(claims, gameId) {
  const restrict = Array.isArray(claims.restrict) ? claims.restrict : [];
  return new Set(restrict.filter((r) => typeof r === 'string' && (!r.includes('@') || r.endsWith('@' + gameId))).map((r) => r.split('@')[0]));
}

app.post('/quickplay', express.json({ limit: '1kb' }), async (req, res) => {
  const which = gameFor(req, res);
  if (!which) return;
  if (!which.quickplay) return res.status(404).json({ error: 'Quick Play is not offered for this game.' });
  if (!playerTokens) return res.status(503).json({ error: 'Quick Play is not set up on this router.' });

  const checked = await playerTokens.check(req.headers.authorization);
  if (checked.status) return res.status(checked.status).json({ error: checked.message });
  const { claims } = checked;
  const sub = claims.sub;
  const restricted = tokenRestricts(claims, which.id);
  if (restricted.has('all') || restricted.has('public_play') || !bans.mayPlay(sub, which.id, true)) {
    console.error(`${req.ip} (${sub}) refused Quick Play: banned`);
    return res.status(403).json({ error: 'You cannot join public matches right now.' });
  }
  const recent = (quickPlayRecent.get(sub) || []).filter((t) => t > Date.now() - 60000);
  if (recent.length >= QUICKPLAY_PER_MINUTE) return res.status(429).json({ error: 'Too many Quick Play requests. Please wait a moment.' });
  recent.push(Date.now());
  quickPlayRecent.set(sub, recent);

  // The last wait: from here to the reservation nothing yields, so two requests cannot both
  // find no seat and start a match each.
  const jwks = await currentKeys();

  // One seat per player: a new request replaces any seat still held for them.
  for (const game of allGames) {
    for (const [ticket, r] of game.reservations) if (r.sub === sub) game.reservations.delete(ticket);
  }

  const candidates = allGames
    .filter((g) => g.game === which.id && g.quickPlaySeats() > 0)
    .sort((a, b) => (b.humanCount() - a.humanCount()) || (a.timestamp - b.timestamp));
  let match = candidates[0];
  if (!match) {
    if (allGames.length >= maxGames()) {
      console.warn('Quick Play could not start a match: at capacity (' + maxGames() + ')');
      return res.status(503).json({ error: 'Server is at capacity. Please try again later.' });
    }
    console.log(`Starting a ${which.id} Quick Play match for ${sub} (${allGames.length + 1}/${maxGames()})`);
    match = new Game('Quick Play', 'Yotis Online', req.ip, which, { public: true, numPlayers: which.quickplay.seats, jwks });
    match.quickPlay = true;
    track(match);
  }
  const seat = match.reserve(sub, typeof claims.name === 'string' ? claims.name : '', QUICKPLAY_HOLD_MS);

  const answer = () => {
    const body = { match: match.id, game: match.game, code: match.code, port: match.port, ticket: seat.ticket, expires: new Date(seat.expires).toISOString() };
    if (nginx) body.path = `/game/${match.port}`;
    res.status(200).json(body);
  };
  if (match.port !== '?') return answer();
  // A match still starting: answer when it reports its port, or 502 if it never does.
  const onPort = () => { match.removeListener('exit', onExit); answer(); };
  const onExit = () => { match.removeListener('port', onPort); res.status(502).json({ error: 'Game server failed to start.' }); };
  match.once('port', onPort);
  match.once('exit', onExit);
});

// THE ADMIN API, for the account service's moderation pages (P5) and the studio's tools. Its own
// listener on ADMIN_HOST:ADMIN_PORT (loopback by default), never the public port, and every
// request carries X-Service-Key. Without both settings it does not exist.
//
//   GET  /admin/matches[?game=]        every live match: listing, roster, reservations, process
//   GET  /admin/matches/:id
//   POST /admin/matches/:id/kick       {sub, reason}
//   POST /admin/matches/:id/announce   {text}
//   POST /admin/matches/:id/close      {reason}
//   POST /admin/bans/refresh           fetch the ban list now (after a ban is made or lifted)
function adminApp() {
  const admin = express();
  admin.use((req, res, next) => {
    const given = Buffer.from(String(req.headers['x-service-key'] || ''));
    const want = Buffer.from(config.serviceKey);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(404).json({ error: 'Not found.' });
    next();
  });
  admin.use(express.json({ limit: '4kb' }));
  const matchFor = (req, res) => {
    const match = allGames.find((g) => g.id === req.params.id);
    if (!match) res.status(404).json({ error: 'No such match.' });
    return match;
  };
  admin.get('/admin/matches', (req, res) => {
    const matches = allGames.filter((g) => !req.query.game || g.game === req.query.game).map((g) => g.adminInfo());
    res.json({ matches, games: Object.keys(catalogue.games), bans: bans.status(), capacity: maxGames() });
  });
  admin.get('/admin/matches/:id', (req, res) => {
    const match = matchFor(req, res);
    if (match) res.json(match.adminInfo());
  });
  admin.post('/admin/matches/:id/kick', (req, res) => {
    const match = matchFor(req, res);
    if (!match) return;
    const sub = req.body && req.body.sub;
    if (typeof sub !== 'string' || !match.roster.has(sub)) return res.status(404).json({ error: 'That player is not in this match.' });
    console.log(`(${match.port}): admin kick of ${sub}`);
    res.json({ sent: match.kick(sub, req.body.reason || 'Removed by a moderator.') });
  });
  admin.post('/admin/matches/:id/announce', (req, res) => {
    const match = matchFor(req, res);
    if (!match) return;
    const message = req.body && req.body.text;
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'text is required.' });
    res.json({ sent: match.announce(message.trim()) });
  });
  admin.post('/admin/matches/:id/close', (req, res) => {
    const match = matchFor(req, res);
    if (!match) return;
    console.log(`(${match.port}): admin close`);
    res.json({ closing: match.close((req.body && req.body.reason) || 'Closed by a moderator.') });
  });
  admin.post('/admin/bans/refresh', async (req, res) => {
    const refreshed = await bans.refresh();
    res.status(bans.enabled ? 200 : 404).json(Object.assign({ refreshed }, bans.status()));
  });
  return admin;
}

app.listen(port, () => {
  console.log(`GameRouter launched on ${port}` + (nginx ? ' (nginx proxy mode)' : '') + (!nginx && trustLoopbackProxy ? ' (trusting a loopback proxy for client addresses)' : ''));
  // The version is a compatibility gate, not a label -- a client whose string differs by one
  // character sees no servers at all. Print what is in force, because "no games found" is what
  // both a wrong version and an unreachable router look like from inside the game.
  console.log(`Serving version ${version}` +
    (config.versionFromEnv ? ' (from $VERSION)' : ' (from config.json)'));
  // Every game served, one line each, with where the server is spawned from: a lobby that
  // never reports a port is nearly always a wrong serverDir, and this is where to check it.
  console.log(`Games from ${catalogue.source}:`);
  for (const id of Object.keys(catalogue.games)) {
    const g = catalogue.games[id];
    const extra = Object.keys(g.env).map((k) => `${k}=${g.env[k]}`).join(' ');
    console.log(`  ${id} ${g.version}${g.default ? ' (default)' : ''}${g.quickplay ? ' (Quick Play)' : ''}: ${g.bin} ${g.args.join(' ')} in ${g.serverDir}${extra ? '  ' + extra : ''}`);
  }
  console.log(`Yotis Online: ${playerTokens ? 'player tokens from ' + config.accountApi : 'no player tokens (Quick Play off)'}; ${bans.enabled ? 'bans refreshed every ' + config.banRefreshMs + ' ms' : 'no ban list'}`);
});

bans.start();
if (config.adminPort && config.serviceKey) {
  adminApp().listen(config.adminPort, config.adminHost, () => {
    console.log(`Admin API on ${config.adminHost}:${config.adminPort}`);
  });
} else if (config.adminPort) {
  console.error('ADMIN_PORT is set without SERVICE_KEY: the admin API is off.');
}
//module.exports = app;
