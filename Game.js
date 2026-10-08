const { spawn } = require('child_process');
const EventEmitter = require('events').EventEmitter;
const path = require('path');

// Read the same way server.js reads it, from the same file. getInfo() needs it to tell a
// joining client how to reach a lobby -- see the note there.
const { nginx } = require('./config.json');

// WHERE THE GAME SERVER LIVES, and why this is not just a relative path any more.
//
// The default resolves to a sibling `RaifuWarsServer` directory. On the production host
// that name is already taken -- by the OLD 1.13 Node server, a tree full of index.js and
// node_modules. Spawning `hemlock server.hml` in it does not fail loudly; it fails as a
// game that never reports a port, which reaches the player as a lobby that will not start
// and the log as nothing in particular.
//
// GAME_SERVER_DIR points at the shikikan checkout instead. HEMLOCK_BIN is overridable for
// the same class of reason: this is spawned by a pm2-managed process whose PATH is
// whatever pm2 was started with rather than a login shell's, so /usr/local/bin is not
// guaranteed to be on it.
const GAME_SERVER_DIR = process.env.GAME_SERVER_DIR
  || path.resolve(__dirname, '../RaifuWarsServer');
const HEMLOCK_BIN = process.env.HEMLOCK_BIN || 'hemlock';

class Game extends EventEmitter {
  constructor(name, host, ip) {
    super();

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
    this.numPlayers = 4;
    this.locked = 0;
    this.gameSpeed = 0;
    this.gameLength = 0;
    this.mapHash = undefined;
    this.mapName = undefined;

    this.process = spawn(HEMLOCK_BIN, ['server.hml'], {
      cwd: GAME_SERVER_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
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

      // DIED BEFORE IT EVER REPORTED A PORT, which is the failure the client sees as 502 and
      // the only one where the stderr is the whole answer. Printed here, next to the exit, so
      // cause and effect are one entry rather than two files.
      if (this.port === '?') {
        console.error(`game server never reported a port (exit ${code}${signal ? ' signal ' + signal : ''})`);
        console.error(`  cwd: ${GAME_SERVER_DIR}   bin: ${HEMLOCK_BIN}`);
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

    const event = msg.event;
    const value = msg.data;

    switch (event) {
      case 'port':
        console.log(`Game opened on port ${value}`);
        this.port = value;
        this.emit('port', this.port);
      break;
      case 'name':
        console.log(`(${this.port}): Set lobby name to ${value}`);
      break;
      case 'isStarted':
        console.log(`(${this.port}): Game started`);
        this.emit('start');
      break;
      case 'mapHash':
        console.log(`(${this.port}): Set map to ${value}`);
      break;
      case 'numPlayers':
        console.log(`(${this.port}): Set to ${value} number of players`);
      break;
    }

    this[event] = value;
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
      gameLength: this.gameLength
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
