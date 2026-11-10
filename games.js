// games.js -- which games this router serves, and how each one's server is launched.
//
// WHY THIS EXISTS. Everything about a lobby's process used to be one implicit game: one
// version string in config.json, one server directory, one binary, one command line. A second
// game on the same router had nowhere to say that its server needs a different environment
// (the Ganbatte engine's sessions run shikikan with SHIKIKAN_REQUIRE_MAP=0) or a different
// compatibility version -- and, worse, its lobbies would have been listed to every RaifuWars
// client and RaifuWars' to it. A descriptor per game is the smallest change that gives each
// game its own launch command and its own listing.
//
// WHAT A DESCRIPTOR IS. One entry in a JSON object keyed by game id:
//
//   {
//     "raifuwars":      { "version": "v1.14.0", "default": true },
//     "ganbatte-sample": { "version": "v0.1.0",
//                          "serverDir": "/home/me/Yotis/shikikan.hml",
//                          "env": { "SHIKIKAN_REQUIRE_MAP": "0" } }
//   }
//
//   version    the exact-match compatibility gate for this game, and part of its proof-of-work
//              constant. Required.
//   serverDir  where to spawn the server (cwd); a leading ~ is the home directory. Default:
//              GAME_SERVER_DIR, then ../RaifuWarsServer.
//   bin        the binary. Default: HEMLOCK_BIN, then "hemlock". A relative path with a slash
//              ("./px_server") is the release's own (a hemlockc build): it resolves against the
//              match's cwd, so it switches with the release link.
//   args       its arguments. Default: ["server.hml"].
//   env        extra environment for the child, on top of this process's own.
//   default    the game a request means when it names none. Exactly one game is the default:
//              the one that says so, otherwise the first listed.
//   quickplay  offer POST /quickplay for this game: true, or {"seats": n} for the seats a new
//              Quick Play match has until its server reports numPlayers (default 4). Needs
//              ACCOUNT_API_URL (player tokens). Off by default.
//   accessKeyEnv  the NAME of the environment variable holding this game's proof-of-work key
//              ("ACCESS_KEY_GANBATTE"), for a game whose clients ship a different key from
//              ACCESS_KEY. Default: ACCESS_KEY. The name, never the key: games.json is config and
//              the key belongs in the env file beside the other secrets.
//
// EVERY GAME MUST END UP WITH A KEY. A game whose key is unset or empty refuses to load, so the
// router does not start: with an empty key the constant is the version alone, and any proof of
// work against it passes -- staging ran like that for three minutes on 2026-11-04 after an env
// edit wrote ACCESS_KEY= with nothing after it, and nothing said so.
//
// WHERE IT COMES FROM, in order:
//
//   GAMES_JSON   inline JSON (starts with "{") or a path to a file. A test harness passes the
//                inline form so nothing on the far side is written, which is the same reason
//                VERSION and PORT may come from the environment (see server.js).
//   games.json   next to this file, gitignored like config.json, for a deployment.
//   neither      ONE game, built from config.json's version (or $VERSION) and named by
//                config.json's "game" (default "raifuwars"). This is exactly what the router
//                did before descriptors existed, so a deployment with no games.json serves
//                RaifuWars unchanged.
//
// THE CLIENT SIDE. A request names its game with `game=<id>`: a query parameter on GET
// /version, GET /games and GET /games/:code, a body field on POST /games. A request that names
// none means the default game, which is how every RaifuWars client ever shipped keeps working:
// they send nothing, and nothing is what the default game answers to. A request naming an
// unknown game is answered 404, because "no such game" is a client pointed at the wrong
// router, and the alternative -- answering as the default -- would list a stranger's lobbies.

const fs = require('fs');
const os = require('os');
const path = require('path');

// A leading ~ is the home directory, because descriptors are written by hand and by test
// harnesses that know the server as ~/Yotis/shikikan.hml; path.resolve would make it a
// directory literally named ~ and the game would "never report a port".
function expandHome(p) {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
  return p;
}

const DEFAULT_SERVER_DIR = process.env.GAME_SERVER_DIR
  || path.resolve(__dirname, '../RaifuWarsServer');
const DEFAULT_BIN = process.env.HEMLOCK_BIN || 'hemlock';
const DEFAULT_ARGS = ['server.hml'];

function normalise(id, raw) {
  if (!raw || typeof raw !== 'object') throw new Error(`game "${id}": descriptor must be an object`);
  if (typeof raw.version !== 'string' || !raw.version) throw new Error(`game "${id}": version is required`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`game id "${id}": letters, digits, . _ - only`);
  const env = raw.env || {};
  for (const k of Object.keys(env)) {
    if (typeof env[k] !== 'string') throw new Error(`game "${id}": env.${k} must be a string`);
  }
  const accessKeyEnv = raw.accessKeyEnv === undefined ? 'ACCESS_KEY' : raw.accessKeyEnv;
  if (typeof accessKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(accessKeyEnv)) {
    throw new Error(`game "${id}": accessKeyEnv must be an environment variable name (A-Z, 0-9, _)`);
  }
  const key = process.env[accessKeyEnv];
  if (!key || !key.trim()) {
    throw new Error(`game "${id}": no proof-of-work key -- ${accessKeyEnv} is unset or empty`);
  }
  // A CRLF env file leaves a carriage return on the key: no shipped client solves against that,
  // so say so at startup.
  if (key !== key.trim()) {
    throw new Error(`game "${id}": ${accessKeyEnv} has whitespace or a line ending around it`);
  }
  keyEnvs.add(accessKeyEnv);
  return {
    id,
    version: raw.version,
    serverDir: raw.serverDir ? path.resolve(expandHome(raw.serverDir)) : DEFAULT_SERVER_DIR,
    bin: raw.bin || DEFAULT_BIN,
    args: Array.isArray(raw.args) ? raw.args.slice() : DEFAULT_ARGS.slice(),
    env,
    default: raw.default === true,
    quickplay: quickplay(id, raw.quickplay),
    accessKeyEnv
  };
}

// Every variable a game's proof-of-work key came from. Game servers are started without them:
// a match has no use for a key, and one game's server never sees another game's.
const keyEnvs = new Set();

// The environment without any proof-of-work key in it.
function withoutKeys(env) {
  const out = { ...env };
  for (const k of keyEnvs) delete out[k];
  return out;
}

// The proof-of-work key for a game, read when it is needed rather than kept on the descriptor,
// so the descriptor can be logged whole without the key in it.
function accessKeyFor(game) {
  return process.env[game.accessKeyEnv];
}

function quickplay(id, raw) {
  if (raw === undefined || raw === false) return null;
  if (raw === true) return { seats: 4 };
  if (raw && typeof raw === 'object' && (raw.seats === undefined || (Number.isInteger(raw.seats) && raw.seats > 0 && raw.seats <= 64))) {
    return { seats: raw.seats || 4 };
  }
  throw new Error(`game "${id}": quickplay must be true or {"seats": 1-64}`);
}

// Load the descriptors. `legacy` is {version, game} from config.json/env, used only when no
// descriptor source exists. Returns {games: {id: descriptor}, defaultId, source}.
function loadGames(legacy) {
  let raw;
  let source;
  const fromEnv = process.env.GAMES_JSON;
  const file = path.resolve(__dirname, 'games.json');
  if (fromEnv && fromEnv.trim().startsWith('{')) {
    raw = JSON.parse(fromEnv);
    source = '$GAMES_JSON (inline)';
  } else if (fromEnv) {
    raw = JSON.parse(fs.readFileSync(fromEnv, 'utf8'));
    source = fromEnv;
  } else if (fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    source = 'games.json';
  } else {
    const id = legacy.game || 'raifuwars';
    raw = { [id]: { version: legacy.version, default: true } };
    source = 'config.json (one game)';
  }

  const ids = Object.keys(raw);
  if (ids.length === 0) throw new Error('no games are configured');
  const games = {};
  for (const id of ids) games[id] = normalise(id, raw[id]);

  const defaults = ids.filter((id) => games[id].default);
  if (defaults.length > 1) throw new Error(`more than one default game: ${defaults.join(', ')}`);
  const defaultId = defaults[0] || ids[0];
  games[defaultId].default = true;
  return { games, defaultId, source };
}

// The game a request means. `named` is the raw value from the query or body, possibly
// undefined. Returns the descriptor, or null when the name is not one this router serves.
function resolveGame(catalogue, named) {
  if (named === undefined || named === null || named === '') return catalogue.games[catalogue.defaultId];
  if (typeof named !== 'string') return null;
  return catalogue.games[named] || null;
}

module.exports = { loadGames, resolveGame, accessKeyFor, withoutKeys };
