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

    this.process.on('exit', (code, signal) => {
      this.emit('exit', this.port);
      console.log(`(${this.port}): exited with code ${code} signal ${signal}`);
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
