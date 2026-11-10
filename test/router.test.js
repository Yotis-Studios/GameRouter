const { test } = require('node:test');
const assert = require('node:assert/strict');
const { accountService, router, routerExit, drive, until, ACCESS_KEY } = require('./support');

test('hosting, listing and join codes work as every shipped client expects', async (t) => {
  const r = await router(t);
  assert.equal((await r.call('/version')).body, 'v-test');
  const hosted = await r.host();
  assert.equal(hosted.status, 200);
  assert.match(String(hosted.body), /^[0-9]+$/, 'POST /games still answers a bare port');
  const port = Number(hosted.body);
  const list = (await r.call('/games')).body;
  assert.equal(list.length, 1);
  const row = list[0];
  for (const key of ['game', 'name', 'code', 'host', 'players', 'numPlayers', 'timestamp', 'port', 'isStarted', 'locked', 'gameSpeed', 'gameLength']) assert.ok(key in row, key);
  assert.equal(row.port, port); assert.equal(row.name, 'Test Lobby'); assert.equal(row.public, false);
  assert.match(row.id, /^[0-9a-f]{16}$/);
  assert.equal((await r.call('/games/' + row.code)).body.port, port);
  const game = await drive(t, port);
  assert.deepEqual(game.env, { ROUTER_GAME: 'stubgame', ROUTER_MATCH_ID: row.id, ROUTER_PUBLIC: '0', ROUTER_JWKS: '' });
  game.say('players', 3); game.say('mapHash', 'a'.repeat(40)); game.say('mapName', 'Field'); game.say('isStarted', 1);
  await until(async () => (await r.call('/games')).body[0].isStarted === 1);
  const after = (await r.call('/games')).body[0];
  assert.equal(after.players, 3); assert.deepEqual(after.map, { hash: 'a'.repeat(40), name: 'Field' });
});

test('every event shikikan prints today is still read', async (t) => {
  const r = await router(t);
  const port = Number((await r.host()).body);
  const game = await drive(t, port);
  // shikikan.hml's send_event calls: port (already sent), mapHash, mapName, isStarted, players,
  // spectators, gameLength, gameMode, gameSpeed, numPlayers, name, locked.
  game.say('mapHash', 'b'.repeat(40)); game.say('mapName', 'Bay'); game.say('players', 2); game.say('spectators', true);
  game.say('gameLength', 3); game.say('gameMode', 2); game.say('gameSpeed', 1); game.say('numPlayers', 6);
  game.say('name', 'Renamed'); game.say('locked', 1); game.say('isStarted', 1); game.say('isStarted', 0);
  await until(async () => (await r.call('/games')).body[0].name === 'Renamed' && (await r.call('/games')).body[0].isStarted === 0, 3000, () => r.log.join('\n'));
  const row = (await r.call('/games')).body[0];
  assert.deepEqual({ players: row.players, numPlayers: row.numPlayers, locked: row.locked, gameSpeed: row.gameSpeed, gameLength: row.gameLength, map: row.map },
    { players: 2, numPlayers: 6, locked: 1, gameSpeed: 1, gameLength: 3, map: { hash: 'b'.repeat(40), name: 'Bay' } });
  assert.ok(!r.log.some((l) => l.includes('ignored event')), r.log.join('\n'));
});

test('a game server cannot overwrite the router with the events it prints', async (t) => {
  const r = await router(t);
  const port = Number((await r.host()).body);
  const game = await drive(t, port);
  game.say('getInfo', 1); game.say('emit', 'x'); game.say('__proto__', { polluted: true }); game.say('constructor', 1);
  game.say('port', 1); game.say('players', 'lots'); game.say('players', -2); game.raw('not json'); game.raw('null');
  game.say('players', '2');
  await until(async () => (await r.call('/games')).body[0]?.players === 2, 3000, () => r.log.join('\n'));
  const row = (await r.call('/games')).body[0];
  assert.equal(row.port, port, 'a second port is ignored');
  assert.ok(r.log.some((l) => l.includes('ignored event "getInfo"')));
  assert.equal(({}).polluted, undefined);
  // The match still exits cleanly, which needs the router's own emit().
  await r.host(); await r.host();
  assert.equal((await r.host()).status, 429, 'per-IP cap still counts every game');
  assert.equal(r.child.exitCode, null);
});

test('a game server that dies before reporting a port is a 502, and its code is freed', async (t) => {
  const r = await router(t, { games: { stubgame: { env: { STUB_CRASH: '1' } } } });
  const hosted = await r.host();
  assert.equal(hosted.status, 502);
  assert.deepEqual((await r.call('/games')).body, []);
});

test('Quick Play needs a game that offers it and a valid player token', async (t) => {
  const account = await accountService(t);
  const r = await router(t, { account, games: { stubgame: { default: true }, sky: { quickplay: { seats: 2 } } } });
  assert.equal((await r.call('/quickplay', { method: 'POST', json: {} })).status, 404, 'the default game does not offer it');
  assert.equal((await r.call('/quickplay?game=nope', { method: 'POST' })).status, 404);
  assert.equal((await r.call('/quickplay?game=sky', { method: 'POST' })).status, 401);
  assert.equal((await r.call('/quickplay?game=sky', { method: 'POST', headers: { Authorization: 'junk' } })).status, 401);
  const expired = account.token({ sub: 'g:1' }, { exp: Math.floor(Date.now() / 1000) - 5 });
  assert.equal((await r.call('/quickplay?game=sky', { method: 'POST', headers: { Authorization: expired } })).status, 401);
  const forged = account.token({ sub: 'g:1' }, { key: require('crypto').generateKeyPairSync('ed25519').privateKey });
  assert.equal((await r.call('/quickplay?game=sky', { method: 'POST', headers: { Authorization: forged } })).status, 401);
  assert.equal((await r.call('/quickplay?game=sky', { method: 'POST', headers: { Authorization: account.token({ sub: 's:1' }) } })).status, 403);
});

test('Quick Play fills a public match, reserves seats, then starts another', async (t) => {
  const account = await accountService(t);
  const r = await router(t, { account, games: { sky: { quickplay: { seats: 2 } } } });
  const play = (sub, extra = {}) => r.call('/quickplay', { method: 'POST', json: { game: 'sky' }, headers: { Authorization: 'Bearer ' + account.token({ sub, name: 'P' + sub, ...extra }) } });
  const a = await play('g:1');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.match(a.body.ticket, /^[0-9a-f]{32}$/);
  const game = await drive(t, a.body.port);
  assert.equal(game.env.ROUTER_PUBLIC, '1'); assert.equal(game.env.ROUTER_MATCH_ID, a.body.match);
  await until(() => game.commands.some((c) => c.cmd === 'reserve'));
  assert.deepEqual(game.commands[0].data, { ticket: a.body.ticket, sub: 'g:1', name: 'Pg:1', expires: Date.parse(a.body.expires) });

  const b = await play('u:7');
  assert.equal(b.body.match, a.body.match, 'the second player joins the same match');
  const c = await play('g:3');
  assert.notEqual(c.body.match, a.body.match, 'two seats held: a third player gets a new match');

  // A player asking again keeps one seat, not two.
  const again = await play('g:3');
  assert.equal(again.body.match, c.body.match);
  const listed = (await r.admin('/admin/matches/' + c.body.match)).body;
  assert.equal(listed.reservations.length, 1);

  // Joining uses the reservation; leaving frees the seat for someone else.
  game.say('join', { sub: 'g:1', name: 'Ace' }); game.say('join', { sub: 'u:7', name: 'Bee' });
  await until(async () => (await r.admin('/admin/matches/' + a.body.match)).body.roster.length === 2);
  const full = (await r.admin('/admin/matches/' + a.body.match)).body;
  assert.equal(full.reservations.length, 0); assert.equal(full.humans, 2);
  game.say('leave', { sub: 'u:7' });
  await until(async () => (await r.admin('/admin/matches/' + a.body.match)).body.roster.length === 1);
  assert.equal((await play('g:9')).body.match, a.body.match, 'a seat freed by a leave is offered again');

  const listing = (await r.call('/games?game=sky')).body;
  assert.equal(listing.length, 2); assert.ok(listing.every((g) => g.public === true));
});

test('Quick Play joins a started match only when its server says it is joinable', async (t) => {
  const account = await accountService(t);
  const r = await router(t, { account, games: { sky: { quickplay: { seats: 4 } } } });
  const play = (sub) => r.call('/quickplay?game=sky', { method: 'POST', headers: { Authorization: account.token({ sub }) } });
  const first = (await play('g:1')).body;
  const game = await drive(t, first.port);
  game.say('join', { sub: 'g:1', name: 'Ace' }); game.say('isStarted', 1);
  await until(async () => (await r.admin('/admin/matches/' + first.match)).body.isStarted === 1);
  const second = (await play('g:2')).body;
  assert.notEqual(second.match, first.match, 'a started match that does not take players is skipped');
  game.say('joinable', true); game.say('bots', 3); game.say('humans', 1);
  await until(async () => (await r.admin('/admin/matches/' + first.match)).body.joinable === true);
  // The match with the most humans wins: the started one has a human seated, the new one none.
  assert.equal((await play('g:3')).body.match, first.match, 'a joinable match under way takes a bot\'s seat');
});

test('Bans: refused by Quick Play, kicked or muted in a live match, and caught on refresh', async (t) => {
  const account = await accountService(t);
  account.bans = [{ id: 1, subs: ['g:66', 'u:66'], scope: 'all', gameId: null, expires: null }];
  const r = await router(t, { account, games: { sky: { quickplay: true }, other: { quickplay: true } } });
  await until(() => account.banRequests > 0);
  const play = (sub, game = 'sky', extra = {}) => r.call('/quickplay?game=' + game, { method: 'POST', headers: { Authorization: account.token({ sub, ...extra }) } });
  assert.equal((await play('u:66')).status, 403, 'banned through the router\'s list');
  assert.equal((await play('g:5', 'sky', { restrict: ['public_play@sky'] })).status, 403, 'banned through the token');
  assert.equal((await play('g:5', 'other', { restrict: ['public_play@sky'] })).status, 200, 'a game ban stays in its game');

  const match = (await play('g:1')).body;
  const game = await drive(t, match.port);
  game.say('join', { sub: 'g:66', name: 'Banned' });
  await until(() => game.commands.some((c) => c.cmd === 'kick' && c.data.sub === 'g:66'));

  game.say('join', { sub: 'u:8', name: 'Chatty' }); game.say('join', { sub: 'u:9', name: 'Rude' });
  await until(async () => (await r.admin('/admin/matches/' + match.match)).body.roster.length === 3);
  account.bans.push({ id: 2, subs: ['u:8'], scope: 'chat', gameId: null, expires: null });
  account.bans.push({ id: 3, subs: ['u:9'], scope: 'public_play', gameId: 'sky', expires: null });
  assert.equal((await r.admin('/admin/bans/refresh', { method: 'POST' })).body.refreshed, true);
  await until(() => game.commands.some((c) => c.cmd === 'mute' && c.data.sub === 'u:8'));
  await until(() => game.commands.some((c) => c.cmd === 'kick' && c.data.sub === 'u:9'));
  // Muted once, however many refreshes follow.
  const before = account.banRequests;
  await until(() => account.banRequests > before + 2);
  assert.equal(game.commands.filter((c) => c.cmd === 'mute').length, 1);
});

test('A public_play ban does not reach a private match', async (t) => {
  const account = await accountService(t);
  account.bans = [{ id: 1, subs: ['u:9'], scope: 'public_play', gameId: null, expires: null }];
  const r = await router(t, { account });
  await until(() => account.banRequests > 0);
  const port = Number((await r.host()).body);
  const game = await drive(t, port);
  game.say('join', { sub: 'u:9', name: 'Friend' });
  const id = (await r.call('/games')).body[0].id;
  await until(async () => (await r.admin('/admin/matches/' + id)).body.roster.length === 1);
  game.say('public', true);
  await until(() => game.commands.some((c) => c.cmd === 'kick' && c.data.sub === 'u:9'), 3000, () => JSON.stringify(game.commands));
});

test('The admin API: loopback listener, service key, matches, kick, announce, close', async (t) => {
  const account = await accountService(t);
  const r = await router(t, { account, games: { stubgame: { default: true }, stubborn: { env: { STUB_IGNORE_CLOSE: '1' } } } });
  assert.equal((await r.call('/admin/matches')).status, 404, 'not on the public port');
  assert.equal((await r.adminRaw('/admin/matches')).status, 404, 'not without the key');
  assert.equal((await r.adminRaw('/admin/matches', { headers: { 'X-Service-Key': 'wrong' } })).status, 404);

  const port = Number((await r.host()).body);
  const game = await drive(t, port);
  game.say('join', { sub: 'g:4', name: 'Ace' });
  const all = await r.admin('/admin/matches');
  assert.equal(all.status, 200); assert.deepEqual(all.body.games, ['stubgame', 'stubborn']);
  assert.equal(all.body.bans.enabled, true);
  const id = all.body.matches[0].id;
  await until(async () => (await r.admin('/admin/matches/' + id)).body.roster.length === 1);
  const detail = (await r.admin('/admin/matches/' + id)).body;
  assert.equal(detail.roster[0].sub, 'g:4'); assert.equal(detail.roster[0].name, 'Ace'); assert.equal(typeof detail.pid, 'number');

  assert.equal((await r.admin('/admin/matches/' + id + '/kick', { method: 'POST', json: { sub: 'g:5' } })).status, 404);
  assert.equal((await r.admin('/admin/matches/nope/kick', { method: 'POST', json: { sub: 'g:4' } })).status, 404);
  assert.equal((await r.admin('/admin/matches/' + id + '/kick', { method: 'POST', json: { sub: 'g:4', reason: 'spam' } })).body.sent, true);
  assert.equal((await r.admin('/admin/matches/' + id + '/announce', { method: 'POST', json: {} })).status, 400);
  assert.equal((await r.admin('/admin/matches/' + id + '/announce', { method: 'POST', json: { text: 'Server restarts soon' } })).body.sent, true);
  await until(() => game.commands.length >= 2);
  assert.deepEqual(game.commands.slice(0, 2), [{ cmd: 'kick', data: { sub: 'g:4', reason: 'spam' } }, { cmd: 'announce', data: { text: 'Server restarts soon' } }]);

  assert.equal((await r.admin('/admin/matches/' + id + '/close', { method: 'POST', json: { reason: 'test' } })).body.closing, true);
  await until(async () => (await r.call('/games')).body.length === 0);

  // A server that ignores close is terminated after the grace period.
  const stubborn = Number((await r.host({ game: 'stubborn' })).body);
  const stubbornId = (await r.call('/games?game=stubborn')).body[0].id;
  await drive(t, stubborn);
  await r.admin('/admin/matches/' + stubbornId + '/close', { method: 'POST' });
  await until(async () => (await r.call('/games?game=stubborn')).body.length === 0, 8000);
});

test('Every match gets the player token key set, and a new key reaches the live ones', async (t) => {
  const account = await accountService(t);
  const r = await router(t, { account, games: { stubgame: { default: true }, sky: { quickplay: true } } });
  const hosted = Number((await r.host()).body);
  const game = await drive(t, hosted);
  assert.deepEqual(JSON.parse(game.env.ROUTER_JWKS), account.jwks(), 'a hosted match has it');
  const qp = (await r.call('/quickplay?game=sky', { method: 'POST', headers: { Authorization: account.token({ sub: 'g:1' }) } })).body;
  const quick = await drive(t, qp.port);
  assert.deepEqual(JSON.parse(quick.env.ROUTER_JWKS), account.jwks(), 'and a Quick Play match');

  account.rotate();
  // A token under the new key makes the router fetch the set again.
  assert.equal((await r.call('/quickplay?game=sky', { method: 'POST', headers: { Authorization: account.token({ sub: 'g:2' }) } })).status, 200);
  for (const g of [game, quick]) {
    await until(() => g.commands.some((c) => c.cmd === 'jwks'));
    assert.deepEqual(g.commands.find((c) => c.cmd === 'jwks').data, account.jwks());
  }
});

test('A player report reaches the admin API with the lines the server kept', async (t) => {
  const account = await accountService(t);
  const r = await router(t, { account });
  const port = Number((await r.host()).body);
  const game = await drive(t, port);
  const id = (await r.call('/games')).body[0].id;
  game.say('report', { reporter: 'nobody', reason: 'x' });
  game.say('report', { match: 'm', game: 'stubgame', reporter: 'g:1', reporter_name: 'Ace', reported: 'g:2', reported_name: 'Bee', slot: 1, reason: 'rude',
    lines: [{ at: 1, slot: 1, sub: 'g:2', name: 'Bee', text: 'you are bad' }] });
  await until(async () => (await r.admin('/admin/matches/' + id)).body.reports.length === 1);
  const report = (await r.admin('/admin/matches/' + id)).body.reports[0];
  assert.equal(report.match, id, 'the router names the match, not the server');
  assert.deepEqual([report.reporter, report.reported, report.reportedName, report.reason], ['g:1', 'g:2', 'Bee', 'rude']);
  assert.deepEqual(report.lines, [{ at: 1, sub: 'g:2', name: 'Bee', text: 'you are bad' }]);
  // Passed on to the account service, named by this router.
  await until(() => account.reports.length === 1);
  assert.deepEqual([account.reports[0].router, account.reports[0].match, account.reports[0].reporter, account.reports[0].reportedName], ['main', id, 'g:1', 'Bee']);
  assert.equal('forwarded' in account.reports[0], false);
  await until(async () => (await r.admin('/admin/matches/' + id)).body.reports[0].forwarded === true);
});

test('Without the platform settings the router runs as before', async (t) => {
  const r = await router(t, { games: { sky: { quickplay: true } } });
  assert.ok(r.log.some((l) => l.includes('no player tokens (Quick Play off)')));
  assert.equal((await r.call('/quickplay', { method: 'POST' })).status, 503);
  assert.equal((await r.host()).status, 200);
});

test('Each game checks proof of work against its own key, and the key is never logged', async (t) => {
  const r = await router(t, {
    games: { rw: { default: true }, sky: { accessKeyEnv: 'ACCESS_KEY_SKY' } },
    env: { ACCESS_KEY_SKY: 'sky-client-key' }
  });
  // A shipped client of the default game: names no game, ships ACCESS_KEY.
  const rwHosted = await r.host();
  assert.equal(rwHosted.status, 200);
  assert.equal((await r.host({}, { key: 'sky-client-key' })).status, 401, "the other game's key does not host the default game");
  const skyHosted = await r.host({ game: 'sky' }, { key: 'sky-client-key' });
  assert.equal(skyHosted.status, 200);
  assert.equal((await r.host({ game: 'sky' })).status, 401, 'ACCESS_KEY does not host a game with its own key');
  assert.ok(r.log.some((l) => l.includes('sky v-test') && l.includes('(key from ACCESS_KEY_SKY)')));
  assert.ok(!r.log.some((l) => l.includes('sky-client-key') || l.includes(ACCESS_KEY)), 'no key in the log');
  // Neither game's server is started with a key, its own or the other game's.
  const rw = await drive(t, Number(rwHosted.body));
  const sky = await drive(t, Number(skyHosted.body));
  assert.deepEqual(rw.keys, []);
  assert.deepEqual(sky.keys, []);
});

test('A game with no proof-of-work key keeps the router from starting', async (t) => {
  const empty = await routerExit(t, { env: { ACCESS_KEY: '' } });
  assert.notEqual(empty.code, 0);
  assert.match(empty.log, /game "stubgame": no proof-of-work key -- ACCESS_KEY is unset or empty/);
  const unset = await routerExit(t, { games: { sky: { accessKeyEnv: 'ACCESS_KEY_NOT_SET_ANYWHERE' } } });
  assert.notEqual(unset.code, 0);
  assert.match(unset.log, /ACCESS_KEY_NOT_SET_ANYWHERE is unset or empty/);
  const blank = await routerExit(t, { env: { ACCESS_KEY: '   ' } });
  assert.notEqual(blank.code, 0);
  assert.match(blank.log, /ACCESS_KEY is unset or empty/);
  const crlf = await routerExit(t, { env: { ACCESS_KEY: 'test-access-key\r' } });
  assert.notEqual(crlf.code, 0);
  assert.match(crlf.log, /ACCESS_KEY has whitespace or a line ending around it/);
  assert.ok(!crlf.log.includes('test-access-key'), 'no key in the log');
  // One game from config.json (no games.json) is held to the same rule.
  const legacy = await routerExit(t, { env: { ACCESS_KEY: '', GAMES_JSON: '' } });
  assert.notEqual(legacy.code, 0);
  assert.match(legacy.log, /no proof-of-work key -- ACCESS_KEY is unset or empty/);
  const bad = await routerExit(t, { games: { sky: { accessKeyEnv: 'the key itself?' } } });
  assert.notEqual(bad.code, 0);
  assert.match(bad.log, /accessKeyEnv must be an environment variable name/);
});
