// The router's test harness: the real server.js in a child process, with stub game servers
// (stub-game.js) and a stub account service (player token keys and the ban list), all on
// loopback and free ports. Nothing is written next to the router: config and games come from
// the environment, and gamedata.db lands in a temporary directory.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const md5 = require('md5');

const ROOT = path.resolve(__dirname, '..');
const STUB = path.join(__dirname, 'stub-game.js');
const ACCESS_KEY = 'test-access-key';
const SERVICE_KEY = 'test-service-key-0123456789abcdef';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

// The account service: /api/.well-known/jwks and /internal/bans, and a signer for tokens.
async function accountService(t) {
  let { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  let kid = 'test-key';
  /** @type {any} */
  const state = { bans: [], banRequests: 0, reports: [], results: [] };
  state.jwks = () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] });
  // A new signing key, as when the account service rotates it.
  state.rotate = () => {
    ({ privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'));
    kid = 'test-key-' + crypto.randomBytes(4).toString('hex');
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/api/.well-known/jwks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state.jwks()));
    }
    if (req.url === '/internal/reports' && req.method === 'POST' && req.headers['x-service-key'] === SERVICE_KEY) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        state.reports.push(JSON.parse(body));
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: state.reports.length }));
      });
      return;
    }
    if (req.url === '/internal/results' && req.method === 'POST' && req.headers['x-service-key'] === SERVICE_KEY) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        state.results.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ players: [], source: 'server' }));
      });
      return;
    }
    if (req.url === '/internal/bans' && req.headers['x-service-key'] === SERVICE_KEY) {
      state.banRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ bans: state.bans, at: new Date().toISOString() }));
    }
    res.writeHead(404);
    res.end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  state.url = 'http://127.0.0.1:' + /** @type {net.AddressInfo} */ (server.address()).port;
  state.token = (claims, /** @type {{ key?: crypto.KeyObject, exp?: number }} */ { key, exp } = {}) => {
    key = key || privateKey;
    const now = Math.floor(Date.now() / 1000);
    const input = b64({ alg: 'EdDSA', typ: 'JWT', kid }) + '.' + b64({ iss: 'yotisonline', kind: claims.sub && claims.sub[0] === 'u' ? 'user' : 'guest', name: 'Pilot', iat: now, exp: exp || now + 3600, ...claims });
    return input + '.' + crypto.sign(null, Buffer.from(input), key).toString('base64url');
  };
  return state;
}

// The router, with `games` as its descriptors (stub servers unless a descriptor says otherwise).
async function router(t, /** @type {{ games?: object, env?: object, account?: any }} */ { games, env = {}, account } = {}) {
  const port = await freePort();
  const adminPort = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamerouter-test-'));
  const descriptors = {};
  for (const [id, d] of Object.entries(games || { stubgame: { default: true } })) {
    descriptors[id] = { version: 'v-test', bin: process.execPath, args: [STUB], serverDir: dir, ...d };
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      VERSION: 'v-test',
      ACCESS_KEY,
      NGINX: '0',
      COLLECT_METADATA: '1',
      GAMES_JSON: JSON.stringify(descriptors),
      CLOSE_GRACE_MS: '300',
      ...(account ? { ACCOUNT_API_URL: account.url, SERVICE_KEY, ADMIN_PORT: String(adminPort), BAN_REFRESH_MS: '200', JWKS_REFETCH_MS: '0' } : {}),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  const onLine = (line) => { log.push(line); if (process.env.GAMEROUTER_TEST_LOG) console.log('  router| ' + line); };
  readline.createInterface({ input: child.stdout }).on('line', onLine);
  readline.createInterface({ input: child.stderr }).on('line', onLine);
  t.after(() => {
    child.kill();
    return new Promise((r) => {
      if (child.exitCode !== null) return r();
      child.once('exit', r);
    }).then(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  });
  await until(() => log.some((l) => l.startsWith('Yotis Online:')), 10000, () => log.join('\n'));
  if (account) await until(() => log.some((l) => l.startsWith('Admin API on')), 5000, () => log.join('\n'));
  const base = 'http://127.0.0.1:' + port;
  const adminBase = 'http://127.0.0.1:' + adminPort;
  /**
   * @param {string} url
   * @param {{ method?: string, form?: Record<string, string>, json?: any, headers?: Record<string, string> }} [opts]
   * @returns {Promise<{ status: number, body: any }>}
   */
  const call = async (url, { method = 'GET', form, json, headers = {} } = {}) => {
    /** @type {RequestInit & { headers: Record<string, string> }} */
    const init = { method, headers: { ...headers } };
    if (form) { init.body = new URLSearchParams(form).toString(); init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (json) { init.body = JSON.stringify(json); init.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(url, init);
    const raw = await r.text();
    /** @type {any} */
    let body = raw;
    try { body = JSON.parse(raw); } catch { /* text */ }
    return { status: r.status, body };
  };
  return {
    log,
    child,
    call: (p, o) => call(base + p, o),
    admin: (p, o = {}) => call(adminBase + p, { ...o, headers: { 'X-Service-Key': SERVICE_KEY, ...(o.headers || {}) } }),
    adminRaw: (p, o) => call(adminBase + p, o),
    // Host a game the way every shipped client does: challenge, proof of work, POST /games.
    // `key` is the proof-of-work key the client ships (default: the router's ACCESS_KEY).
    /** @param {Record<string, any>} [fields] @param {{ key?: string }} [opts] */
    async host(fields = {}, { key = ACCESS_KEY } = {}) {
      const challenge = (await call(base + '/challenge', { method: 'POST' })).body;
      const version = (await call(base + '/version' + (fields.game ? '?game=' + fields.game : ''))).body;
      let solution = 0;
      while (!md5(key + version + challenge + solution).startsWith('000')) solution++;
      return call(base + '/games', { method: 'POST', form: { pow: String(solution), host: 'Tester', name: 'Test Lobby', ...fields } });
    }
  };
}

// A connection to a stub game server on `port`: say() makes the game print an event, and
// commands lists what the router told it. env is the ROUTER_* environment it was started with.
async function drive(t, port) {
  const socket = net.connect(port, '127.0.0.1');
  // Reset when the router ends the match at teardown.
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  const lines = [];
  // readline re-emits the socket's errors as its own.
  readline.createInterface({ input: socket }).on('line', (l) => lines.push(JSON.parse(l))).on('error', () => {});
  await until(() => lines.length > 0);
  return {
    env: lines[0].env,
    // The ACCESS_KEY* variables the server was started with (names only).
    keys: lines[0].keys,
    get commands() { return lines.slice(1); },
    say: (event, data) => socket.write(JSON.stringify({ event, data }) + '\n'),
    raw: (line) => socket.write(line + '\n')
  };
}

async function until(fn, ms = 3000, describe) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out' + (describe ? ':\n' + describe() : ''));
    await new Promise((r) => setTimeout(r, 20));
  }
}

// A router that is expected NOT to start: resolves with its exit code and log once it exits.
function routerExit(t, /** @type {{ games?: object, env?: object }} */ { games, env = {} } = {}) {
  const descriptors = {};
  for (const [id, d] of Object.entries(games || { stubgame: { default: true } })) {
    descriptors[id] = { version: 'v-test', bin: process.execPath, args: [STUB], serverDir: os.tmpdir(), ...d };
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: os.tmpdir(),
    env: { ...process.env, PORT: '0', VERSION: 'v-test', ACCESS_KEY, NGINX: '0', COLLECT_METADATA: '0',
      GAMES_JSON: JSON.stringify(descriptors), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  const timer = setTimeout(() => child.kill(), 10000);
  t.after(() => { clearTimeout(timer); child.kill(); });
  return new Promise((resolve) => child.on('exit', (code) => { clearTimeout(timer); resolve({ code, log: log.join('') }); }));
}

module.exports = { accountService, router, routerExit, drive, until, SERVICE_KEY, ACCESS_KEY };
