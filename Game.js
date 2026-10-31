const { spawn } = require('child_process');
const crypto = require('crypto');
const EventEmitter = require('events').EventEmitter;

// The same setting server.js uses, environment included. getInfo() needs it to tell a joining
// client how to reach a lobby -- see the note there.
const { nginx } = require('./config');

// THE EVENTS A GAME SERVER MAY REPORT, and how each value is read. Anything else is logged and
// dropped.
//
// An allow-list because this used to be `this[event] = value` for whatever the child printed:
// a server printing {"event":"getInfo"} or {"event":"emit"} replaced the router's own methods,
// and the next listing or exit threw inside the router. A game server is our code, but it is
// also the process that parses every packet a player sends, so the router does not let it name
// what to overwrite.
// Numbers may arrive as digit strings; whatever a server printed before this list existed still
// reads the same.
const num = (v) => (typeof v === 'string' && /^[0-9]{1,10}$/.test(v) ? Number(v) : v);
const int = (max) => (v) => { v = num(v); return Number.isInteger(v) && v >= 0 && v <= max ? v : undefined; };
const text = (max) => (v) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const flag = (v) => { v = num(v); return v === true || v === 1 ? 1 : (v === false || v === 0 ? 0 : undefined); };
const bool = (v) => { v = num(v); return typeof v === 'boolean' ? v : (v === 1 || v === 0 ? v === 1 : undefined); };
const FIELDS = {
  port: (v) => { v = num(v); return Number.isInteger(v) && v > 0 && v < 65536 ? v : undefined; },
  players: int(1000),
  numPlayers: int(1000),
  name: text(100),
  isStarted: flag,
  locked: flag,
  gameSpeed: int(1000),
  gameLength: int(1000000),
  gameMode: int(1000),
  spectators: bool,
  mapHash: text(64),
  mapName: text(100),
  // Platform state (P3). public: listed for Quick Play and held to public_play bans. humans and
  // bots: who fills the seats. joinable: a started match still takes players (a bot's seat).
  public: bool,
  humans: int(1000),
  bots: int(1000),
  joinable: bool
};

// A seated player, as the game server verified them (from their player token, P4). Bots are
// "b:" when the platform issues them; until then a game server reports only humans.
const SUB = /^[ugb]:[1-9][0-9]{0,9}$/;

// How long a match gets to close itself after a close command before it is terminated, then
// killed. CLOSE_GRACE_MS in the environment shortens it for tests.
const CLOSE_GRACE_MS = Number(process.env.CLOSE_GRACE_MS) || 10000;
const KILL_GRACE_MS = 5000;

// WHERE THE GAME SERVER LIVES is now the game descriptor's business (games.js): its
// serverDir, bin, args and env. The defaults there are the ones that used to live here --
// GAME_SERVER_DIR then ../RaifuWarsServer, HEMLOCK_BIN then `hemlock` -- and the reasons
// still apply: a wrong directory does not fail loudly, it fails as a game that never
// reports a port, and a pm2-managed process has whatever PATH pm2 was started with.

class Game extends EventEmitter {
  // options.public: a match the router made public (Quick Play). options.numPlayers: its seats
  // until the server reports them. options.jwks: the player token key set, so the server can
  // verify its players' tokens itself.
  constructor(name, host, ip, descriptor, options = {}) {
    super();

    // Which game this lobby belongs to. Listed and filtered by it; never joined across it.
    this.game = descriptor.id;
    this.descriptor = descriptor;
    // The match's own id, for the admin API, Quick Play tickets and later the bots and reports
    // that refer to one match. Random, not the port: ports are reused as soon as a match ends.
    this.id = crypto.randomBytes(8).toString('hex');

    this.db_id = null;
    this.port = '?';
    // Short join code. Assigned by server.js rather than here, because uniqueness is a
    // property of every game that exists and a Game knows nothing about its siblings. Stays
    // null if the router could not mint one, which is survivable -- see code.js.
    this.code = null;
    this.name = name;
    this.host = host;
    this.ip = ip;
    this.timestamp = Date.now();
    this.isStarted = 0;
    this.players = 1;
    this.numPlayers = options.numPlayers || 4;
    this.locked = 0;
    this.gameSpeed = 0;
    this.gameLength = 0;
    this.mapHash = undefined;
    this.mapName = undefined;
    this.public = options.public === true;
    this.humans = undefined;
    this.bots = undefined;
    this.joinable = undefined;

    // Who is seated, by verified sub: sub -> {name, joined}. Filled by the server's join and
    // leave events.
    this.roster = new Map();
    // Seats held for Quick Play: ticket -> {sub, name, expires}. A reservation ends when its
    // player joins or it expires.
    this.reservations = new Map();
    // Subs the match has been told to mute, so a refreshed ban list does not repeat it.
    this.muted = new Set();
    // Reports its players made (the server attaches the chat lines), newest last, until the
    // account service takes them (P5).
    this.reports = [];
    this.closing = false;

    this.process = spawn(descriptor.bin, descriptor.args, {
      cwd: descriptor.serverDir,
      // ROUTER_* tell the server which match it is, whether the router made it public (it then
      // fills empty seats with bots and takes Quick Play players), and the key set its players'
      // tokens are signed with.
      env: Object.assign({}, process.env, descriptor.env, {
        ROUTER_GAME: this.game,
        ROUTER_MATCH_ID: this.id,
        ROUTER_PUBLIC: this.public ? '1' : '0',
        ROUTER_JWKS: options.jwks ? JSON.stringify(options.jwks) : ''
      }),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // A server that exits, or never reads its stdin, must not take the router down with an
    // EPIPE on a command written to it.
    this.process.stdin.on('error', (err) => {
      console.error(`(${this.port}): command channel closed: ${err.message}`);
    });

    // Buffer for partial lines on stdout
    this._stdoutBuffer = '';

    this.process.stdout.on('data', (data) => {
      this._stdoutBuffer += data.toString();
      const lines = this._stdoutBuffer.split('\n');
      // Keep the last partial line in the buffer
      this._stdoutBuffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this._handleEvent(trimmed);
      }
    });

    // KEPT, not just printed. A game that dies before reporting a port becomes a bare
    // "502 Game server failed to start" at the client, and the actual reason -- always in
    // the child's stderr -- lands in a DIFFERENT pm2 log file from the "Starting a game"
    // line, interleaved with every other game's output. Correlating the two by eye is what
    // made a three-layer startup failure (no libwebsockets, then no stdlib, then no
    // hem_modules) take three round trips to diagnose instead of one.
    //
    // Capped, because this buffer exists for the moments after a spawn and a healthy game
    // runs for hours: without a cap, a server that logs to stderr in a loop would grow it
    // for the life of the match.
    this._stderr = [];
    this.process.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        this._stderr.push(text);
        if (this._stderr.length > 20) this._stderr.shift();
      }
      console.error(`(${this.port}): ${text}`);
    });

    // Without this, a failed spawn (missing hemlock binary, bad cwd, or the
    // OS refusing to fork under load) emits an unhandled 'error' on the
    // child process, which Node treats as an uncaught exception and crashes
    // the *entire* GameRouter -- taking down every other game and the API
    // for all players, not just this one request.
    this._exited = false;
    this.process.on('error', (err) => {
      console.error(`(${this.port}): failed to start game server: ${err.message}`);
      if (!this._exited) {
        this._exited = true;
        this.emit('exit', this.port);
      }
    });

    this.process.on('exit', (code, signal) => {
      console.log(`(${this.port}): exited with code ${code} signal ${signal}`);
      clearTimeout(this._closeTimer);
      clearTimeout(this._killTimer);

      // DIED BEFORE IT EVER REPORTED A PORT, which is the failure the client sees as 502 and
      // the only one where the stderr is the whole answer. Printed here, next to the exit, so
      // cause and effect are one entry rather than two files.
      if (this.port === '?') {
        console.error(`game server never reported a port (exit ${code}${signal ? ' signal ' + signal : ''})`);
        console.error(`  game: ${this.game}   cwd: ${this.descriptor.serverDir}   bin: ${this.descriptor.bin} ${this.descriptor.args.join(' ')}`);
        if (this._stderr.length) {
          for (const line of this._stderr) console.error(`  | ${line}`);
        } else {
          console.error('  | (nothing on stderr -- check that the binary and cwd above exist)');
        }
      }

      if (!this._exited) {
        this._exited = true;
        this.emit('exit', this.port);
      }
    });
  }

  _handleEvent(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      // Not JSON — treat as plain log output
      console.log(`(${this.port}): ${line}`);
      return;
    }

    const event = msg && msg.event;
    const value = msg && msg.data;

    // Who comes and goes, by the sub the server verified.
    if (event === 'join' || event === 'leave') {
      const sub = value && SUB.test(value.sub) ? value.sub : null;
      if (!sub) {
        console.error(`(${this.port}): ${event} without a valid sub, ignored`);
        return;
      }
      if (event === 'join') {
        const name = typeof value.name === 'string' ? value.name.slice(0, 32) : '';
        this.roster.set(sub, { name, joined: Date.now() });
        for (const [ticket, r] of this.reservations) if (r.sub === sub) this.reservations.delete(ticket);
      } else {
        this.roster.delete(sub);
        this.muted.delete(sub);
      }
      this.emit(event, sub);
      return;
    }

    // A player's report: who, about whom, why, and the chat lines the server kept.
    if (event === 'report') {
      const r = value && typeof value === 'object' ? value : null;
      if (!r || !SUB.test(r.reporter) || typeof r.reason !== 'string') {
        console.error(`(${this.port}): report without a valid reporter, ignored`);
        return;
      }
      const lines = Array.isArray(r.lines) ? r.lines.slice(-30).map((l) => ({
        at: Number(l && l.at) || 0,
        sub: l && SUB.test(l.sub) ? l.sub : null,
        name: String((l && l.name) || '').slice(0, 32),
        text: String((l && l.text) || '').slice(0, 500)
      })) : [];
      const report = {
        match: this.id,
        game: this.game,
        reporter: r.reporter,
        reporterName: String(r.reporter_name || '').slice(0, 32),
        reported: SUB.test(r.reported) ? r.reported : null,
        reportedName: String(r.reported_name || '').slice(0, 32),
        reason: r.reason.slice(0, 200),
        lines,
        at: new Date().toISOString()
      };
      this.reports.push(report);
      if (this.reports.length > 50) this.reports.shift();
      console.log(`(${this.port}): ${report.reporter} reported ${report.reported || report.reportedName}: ${report.reason}`);
      this.emit('report', report);
      return;
    }

    const read = Object.prototype.hasOwnProperty.call(FIELDS, event) ? FIELDS[event] : null;
    const parsed = read ? read(value) : undefined;
    if (parsed === undefined) {
      console.error(`(${this.port}): ignored event ${JSON.stringify(String(event)).slice(0, 40)}`);
      return;
    }

    switch (event) {
      case 'port':
        // Once. A second port would re-key the match under a port it may not own.
        if (this.port !== '?') return;
        console.log(`Game opened on port ${parsed}`);
        this.port = parsed;
        this.emit('port', this.port);
        return;
      case 'name':
        console.log(`(${this.port}): Set lobby name to ${parsed}`);
      break;
      case 'isStarted':
        if (parsed === 1 && this.isStarted !== 1) {
          console.log(`(${this.port}): Game started`);
          this.isStarted = 1;
          this.emit('start');
          return;
        }
      break;
      case 'mapHash':
        console.log(`(${this.port}): Set map to ${parsed}`);
      break;
      case 'numPlayers':
        console.log(`(${this.port}): Set to ${parsed} number of players`);
      break;
    }

    this[event] = parsed;
  }

  // THE COMMAND CHANNEL: one JSON line per command on the server's stdin,
  //   {"cmd": "<name>", "data": {...}}
  // kick {sub, reason}, mute {sub}, announce {text}, close {reason}, reserve {ticket, sub, name,
  // expires}. A server that does not know a command ignores it (shikikan learns them in P4).
  // Returns false when the server can no longer be told anything.
  send(cmd, data) {
    if (this._exited || !this.process.stdin.writable) return false;
    this.process.stdin.write(JSON.stringify({ cmd, data }) + '\n');
    return true;
  }

  kick(sub, reason) {
    return this.send('kick', { sub, reason: String(reason || '').slice(0, 200) });
  }

  mute(sub) {
    if (this.muted.has(sub)) return true;
    this.muted.add(sub);
    return this.send('mute', { sub });
  }

  announce(message) {
    return this.send('announce', { text: String(message).slice(0, 200) });
  }

  // Ask the match to end, then make sure it does: a server that ignores the command, or does
  // not have it yet, is terminated after CLOSE_GRACE_MS and killed after KILL_GRACE_MS more.
  close(reason) {
    if (this._exited) return false;
    if (this.closing) return true;
    this.closing = true;
    this.send('close', { reason: String(reason || '').slice(0, 200) });
    this._closeTimer = setTimeout(() => {
      this.process.kill('SIGTERM');
      this._killTimer = setTimeout(() => this.process.kill('SIGKILL'), KILL_GRACE_MS);
    }, CLOSE_GRACE_MS);
    return true;
  }

  // Seated humans: what the server says, or the roster's accounts and guests when it says
  // nothing.
  humanCount() {
    if (this.humans !== undefined) return this.humans;
    let n = 0;
    for (const sub of this.roster.keys()) if (sub[0] !== 'b') n++;
    return n;
  }

  // Seats Quick Play may hand out now: a public, unlocked match that is open, or started and
  // still joinable, less its humans and the reservations not yet used. Bots' seats count as
  // open, because taking a bot's seat is the point.
  quickPlaySeats(now = Date.now()) {
    for (const [ticket, r] of this.reservations) if (r.expires <= now) this.reservations.delete(ticket);
    if (!this.public || this.closing || this._exited || this.locked) return 0;
    if (this.isStarted && this.joinable !== true) return 0;
    return Math.max(0, this.numPlayers - this.humanCount() - this.reservations.size);
  }

  // Hold a seat for `sub` for `ms` and tell the server, so it seats that player (and only that
  // player) on the ticket.
  reserve(sub, name, ms) {
    const ticket = crypto.randomBytes(16).toString('hex');
    const expires = Date.now() + ms;
    this.reservations.set(ticket, { sub, name, expires });
    if (this.port !== '?') this.send('reserve', { ticket, sub, name, expires });
    else this.once('port', () => this.send('reserve', { ticket, sub, name, expires }));
    return { ticket, expires };
  }

  // Everything the admin API shows: the listing, plus who is in it and its process.
  adminInfo() {
    const now = Date.now();
    return Object.assign(this.getInfo(), {
      ip: this.ip,
      pid: this.process.pid,
      uptime: Math.floor((now - this.timestamp) / 1000),
      closing: this.closing,
      roster: [...this.roster].map(([sub, p]) => ({ sub, name: p.name, joined: new Date(p.joined).toISOString(), muted: this.muted.has(sub) })),
      reservations: [...this.reservations.values()].filter((r) => r.expires > now).map((r) => ({ sub: r.sub, expires: new Date(r.expires).toISOString() })),
      reports: this.reports
    });
  }

  // HOW TO REACH THIS LOBBY, not just which port it sits on.
  //
  // In nginx mode the port is NOT dialable: production runs ufw default-deny with only
  // 22, 80, 443, 42069 and 6969 open, so a player's new inbound connection to a spawned
  // lobby is dropped and the client sits on "Connection timed out". Every lobby is reached
  // through the reverse proxy instead, by path, on :80.
  //
  // The HOST already learns this -- POST /games answers `/game/<port>` when nginx is set
  // (see server.js). A JOINER had no way to know: the listing gave it a bare port number
  // and it dialled straight into the firewall. So the listing says it too, and a client
  // that finds `path` uses it in preference to `port`.
  //
  // ADDITIVE ON PURPOSE. `port` stays exactly as it was, so a client that does not know
  // about this field behaves as before, and a router with nginx off emits no path at all.
  getInfo() {
    const info = {
      // Which game: the list is already filtered by it, so this is for a client that wants to
      // be sure, and for anyone reading the JSON by hand.
      game: this.game,
      name: this.name,
      // How the HOST learns its own code: it finds its row in the list it already fetches.
      // Adding a key to this object is additive -- a client that does not read it is
      // unaffected -- whereas carrying the code in the POST /games response would have meant
      // changing that response from a bare port string into something structured, which is
      // exactly the kind of change the version gate exists to stop mid-deploy.
      code: this.code,
      host: this.host,
      players: this.players,
      numPlayers: this.numPlayers,
      timestamp: this.timestamp,
      port: this.port,
      isStarted: this.isStarted,
      locked: this.locked,
      gameSpeed: this.gameSpeed,
      gameLength: this.gameLength,
      // Platform fields (P3), additive like `code`: the match id, whether it is public, and who
      // fills it. humans/bots/joinable are null until the server reports them.
      id: this.id,
      public: this.public,
      humans: this.humans !== undefined ? this.humans : (this.roster.size ? this.humanCount() : null),
      bots: this.bots !== undefined ? this.bots : null,
      joinable: this.joinable !== undefined ? this.joinable : null
    };
    if (nginx) {
      info.path = `/game/${this.port}`;
    }
    if (this.mapHash && this.mapName) {
      info.map = {
        hash: this.mapHash,
        name: this.mapName
      };
    }
    return info;
  }

  canJoin() {
    return this.isStarted == 0 && this.players < 4
      && this.mapHash !== undefined && this.mapHash.length == 40;
  }
}

module.exports = Game;
