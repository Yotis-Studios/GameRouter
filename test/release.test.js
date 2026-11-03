// Game server releases: a serverDir that is a link to the current release (tools/game-release.sh).
// A match runs in the release the link named when it started; switching the link changes what
// the next match runs and nothing else. Linux only: the tool reads /proc and symlinks are POSIX.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { accountService, router, until } = require('./support');

const TOOL = path.join(__dirname, '..', 'tools', 'game-release.sh');
const skip = process.platform === 'win32' ? 'symlinks and /proc: run on Linux' : false;

test('a running match keeps its release when the link moves; the next one gets the new one', { skip }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'release-router-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'game.releases', 'one'), { recursive: true });
  fs.mkdirSync(path.join(base, 'game.releases', 'two'), { recursive: true });
  const link = path.join(base, 'game');
  fs.symlinkSync('game.releases/one', link);

  const r = await router(t, { account: await accountService(t), games: { stubgame: { default: true, serverDir: link } } });
  assert.equal((await r.host()).status, 200);
  const first = (await r.call('/games')).body[0];

  fs.symlinkSync('game.releases/two', link + '.new');
  fs.renameSync(link + '.new', link);
  assert.equal((await r.host()).status, 200);
  const second = (await r.call('/games')).body.find((g) => g.id !== first.id);

  const real = fs.realpathSync(path.join(base, 'game.releases'));
  assert.equal((await r.admin('/admin/matches/' + first.id)).body.release, path.join(real, 'one'));
  assert.equal((await r.admin('/admin/matches/' + second.id)).body.release, path.join(real, 'two'));
});

// The tool, against a throwaway link. A release is a tarball holding a tiny server that does what
// the router waits for: print {"event":"port"} and listen on it.
function tool(args, input) {
  const res = spawnSync('bash', [TOOL, ...args], { input, encoding: undefined });
  return { code: res.status, out: String(res.stdout) + String(res.stderr) };
}
function releaseTar(dir, { good = true } = {}) {
  const src = fs.mkdtempSync(path.join(dir, 'src-'));
  fs.writeFileSync(path.join(src, 'server.js'), good
    ? "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(JSON.stringify({event:'port',data:s.address().port})));setInterval(()=>{},1000);"
    : "console.error('no port today'); process.exit(1);");
  const tar = spawnSync('tar', ['-czf', '-', '-C', src, '.']);
  fs.rmSync(src, { recursive: true, force: true });
  return tar.stdout;
}

test('game-release.sh: adopt, deploy with preflight, refuse a bad release, roll back, prune', { skip }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tool-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const link = path.join(base, 'game');
  const rel = link + '.releases';
  fs.mkdirSync(link);
  fs.writeFileSync(path.join(link, 'old.txt'), 'the release before releases');
  const start = ['--start', `${process.execPath} server.js`, '--timeout', '5'];

  // The first deploy adopts the plain directory and switches to the new release.
  let res = tool(['deploy', link, 'v2', ...start], releaseTar(base));
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /preflight ok/);
  assert.equal(fs.readlinkSync(link), 'game.releases/v2');
  const adopted = fs.readdirSync(rel).find((d) => d.startsWith('adopted-'));
  assert.ok(adopted, 'the plain directory was kept as a release');
  assert.equal(fs.readFileSync(path.join(rel, adopted, 'old.txt'), 'utf8'), 'the release before releases');

  // A release that never reports a port is installed but not activated.
  res = tool(['deploy', link, 'broken', ...start], releaseTar(base, { good: false }));
  assert.notEqual(res.code, 0);
  assert.match(res.out, /preflight FAILED/);
  assert.equal(fs.readlinkSync(link), 'game.releases/v2', 'the link did not move');

  // Names are never reused.
  res = tool(['install', link, 'v2'], releaseTar(base));
  assert.notEqual(res.code, 0);
  assert.match(res.out, /already exists/);

  res = tool(['deploy', link, 'v3', ...start], releaseTar(base));
  assert.equal(res.code, 0, res.out);
  res = tool(['rollback', link]);
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.readlinkSync(link), 'game.releases/v2');
  res = tool(['activate', link, 'v3', ...start]);
  assert.equal(res.code, 0, res.out);

  // A match still running in the adopted release keeps it through a prune; once it ends, it goes.
  const match = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: path.join(rel, adopted), stdio: 'ignore' });
  t.after(() => match.kill());
  await until(() => fs.existsSync(`/proc/${match.pid}/cwd`) && fs.readlinkSync(`/proc/${match.pid}/cwd`).endsWith(adopted));
  res = tool(['status', link]);
  assert.match(res.out, new RegExp(`${adopted}\\s+live\\(1\\)`), res.out);
  res = tool(['prune', link, '--keep', '0']);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, new RegExp(`keeping ${adopted}: a match is running in it`));
  assert.ok(fs.existsSync(path.join(rel, adopted)));
  assert.ok(fs.existsSync(path.join(rel, 'v3')) && fs.existsSync(path.join(rel, 'v2')), 'current and previous are never pruned');
  assert.ok(!fs.existsSync(path.join(rel, 'broken')), 'an unused old release is');

  match.kill();
  await until(() => !fs.existsSync(`/proc/${match.pid}`));
  res = tool(['prune', link, '--keep', '0']);
  assert.ok(!fs.existsSync(path.join(rel, adopted)), res.out);
  assert.match(fs.readFileSync(path.join(rel, 'HISTORY'), 'utf8'), /adopt .*\n.*install v2/);
});
