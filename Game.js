const { spawn } = require('child_process');
const EventEmitter = require('events').EventEmitter;
const path = require('path');

const GAME_SERVER_DIR = path.resolve(__dirname, '../RaifuWarsServer');
const HEMLOCK_BIN = 'hemlock';

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

    this.process.stderr.on('data', (data) => {
      console.error(`(${this.port}): ${data.toString().trim()}`);
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
