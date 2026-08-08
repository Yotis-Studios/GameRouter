const os = require('os');
const bodyParser = require('body-parser');
const express = require('express');
const app = express();

const { version, port, nginx } = require('./config.json');
let { collectMetadata } = require('./config.json');

// In nginx mode, all requests arrive via the local reverse proxy, so trust
// its X-Forwarded-For header to recover the real client IP -- otherwise
// req.ip resolves to the proxy's own address for every request, collapsing
// rate limiting and the per-IP PoW challenge map onto a single shared
// bucket. Only trust the loopback hop (not an arbitrary chain), since
// nginx is expected to run on the same host per the documented setup.
// Outside nginx mode, leave Express's default (don't trust proxy headers
// at all) so a client can't spoof its IP via X-Forwarded-For directly.
if (nginx) {
  app.set('trust proxy', 'loopback');
}

const accessKey = process.env.ACCESS_KEY;
const discordHook = process.env.DISCORD_WEBHOOK;

const { generateChallenge, testSolution } = require('./challenge.js');
const Game = require('./Game');

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

function countGamesForIp(ip) {
  return allGames.filter((g) => g.ip === ip).length;
}

app.get('/version', (req, res) => {
  res.status(200).send(version);
});

// Return joinable games sorted by timestamp
app.get('/games', (req, res) => {
  const gameList = Object.keys(games)
    // .filter(port => games[port].canJoin())
    .map(port => {
      return games[port].getInfo();
    }).sort((a, b) => {
      return b.timestamp - a.timestamp;
    });
  res.status(200).send(gameList);
});

// generate challenge for this ip address
app.post('/challenge', (req, res) => {
  const challenge = generateChallenge();
  const ip = req.ip;
  challenges[ip] = { value: challenge, expires: Date.now() + CHALLENGE_TTL_MS };
  res.send(challenge);
});

// host a raifu wars game
app.post('/games', (req, res) => {
  if (!req.body) {
    res.status(400);
    res.send('Body required.');
    console.error(req.ip + " did not provide body");
    return;
  }
  // Check the user's proof of work before hosting new game
  const pow = req.body.pow;
  if (pow) {
    const stored = challenges[req.ip];
    const challenge = stored && stored.expires > Date.now() ? stored.value : undefined;
    delete challenges[req.ip];
    const challengeConstant = accessKey + version;
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
  const maxGames = Math.floor(os.totalmem() / 50000000) - 5;
  if (numGames >= maxGames) {
    res.status(503);
    res.send('Server is at capacity. Please try again later.');
    console.error(req.ip + ' rejected. Out of system resources!');
    console.warn('Reached max number of games (' + maxGames + ')!');
    return;
  }

  console.log(`Starting a game for ${req.ip} (${numGames+1}/${maxGames})`);

  const host = req.body.host;// : 'Unknown';
  const name = req.body.name;// : 'Raifu Wars Match';
  const newGame = new Game(name, host, req.ip);
  allGames.push(newGame);
  // The HTTP response is normally sent from the 'port' handler below. If the
  // game process exits before ever reporting a port (e.g. it crashed, or
  // picked an already-bound port), nothing would otherwise respond to this
  // request at all -- the caller's connection would just hang forever.
  let responded = false;
  newGame.on('port', (port) => {
    responded = true;
    games[port] = newGame;
    const connectInfo = nginx ? `/game/${port}` : port.toString();
    res.status(200).send(connectInfo);
    if (collectMetadata) db.run('INSERT INTO session (port, host, name, timestamp, ip) VALUES (?, ?, ?, ?, ?)', [port, host, name, newGame.timestamp, req.ip], function(err) {
      if (err) {
        console.error('Failed to insert session into database.');
        console.error(err.message);
      } else {
        // console.log('Inserted session into database.');
        newGame.db_id = this.lastID;
      }
    });
    if (discord != null) discord.send(`**${host}** started a game for Raifu Wars ${version}`);
  });
  newGame.on('start', () => {
    // insert match into database
    if (collectMetadata && newGame.db_id != null) db.run('INSERT INTO match (session_id, players, speed, length, map) VALUES (?, ?, ?, ?, ?)', [newGame.db_id, newGame.players, newGame.gameSpeed, newGame.gameLength, newGame.mapHash], function(err) {
      if (err) {
        console.error('Failed to insert match into database.');
        console.error(err.message);
      } else {
        //console.log('Inserted match into database.');
      }
    });
    // insert map into database
    if (collectMetadata) db.run('INSERT INTO map (hash, name) VALUES (?, ?)', [newGame.mapHash, newGame.mapName], function(err) {
      if (err) {
        // ignore map insert errors because there will be duplicates
        //console.error('Failed to insert map into database.');
        //console.error(err.message);
      } else {
        //console.log('Inserted map into database.');
      }
    });
  });
  newGame.on('exit', (port) => {
    if (port !== '?') delete games[port];
    const idx = allGames.indexOf(newGame);
    if (idx !== -1) allGames.splice(idx, 1);
    if (!responded) {
      responded = true;
      res.status(502).send('Game server failed to start.');
    }
    // get game length in seconds
    const gameLength = Math.floor((Date.now() - newGame.timestamp) / 1000);
    // update session in database
    if (collectMetadata && newGame.db_id != null) db.run('UPDATE session SET name = ?, locked = ?, length = ? WHERE id = ?', [newGame.name, newGame.locked, gameLength, newGame.db_id], function(err) {
      if (err) {
        console.error('Failed to update session in database.');
        console.error(err.message);
      } else {
        //console.log('Updated session in database.');
      }
    });
  });
});

app.listen(port, () => {
  console.log(`GameRouter launched on ${port}` + (nginx ? ' (nginx proxy mode)' : ''));
});
//module.exports = app;
