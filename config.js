// config.js -- every setting, read once, from config.json with the environment on top.
//
// ONE PLACE, because two places drifted: server.js honoured $NGINX while Game.js read
// config.json's nginx directly, so a router started with NGINX=1 handed out /game/<port> to its
// host and a bare port in the listing. Both now read this.
//
// config.json is gitignored and holds the live deployment's values; it stays the source of
// truth, and the environment only overrides it (see the note on VERSION in server.js). It is
// optional, so a test harness can run the router from the environment alone without writing a
// file on the far side.
//
// THE PLATFORM SETTINGS (Yotis Online, yo-account-api docs/PLATFORM.md, phase P3). All optional:
// without them the router behaves exactly as before.
//
//   ACCOUNT_API_URL  the account service. Player tokens are checked against its public key
//                    (/api/.well-known/jwks) and the ban list comes from /internal/bans.
//   SERVICE_KEY      shared with the account service; sent on /internal/bans and required on
//                    every admin API request. Without it there are no bans and no admin API.
//   ADMIN_PORT       where the admin API listens. Default: none.
//   ADMIN_HOST       the address it binds. Default 127.0.0.1: the admin API is never on the port
//                    the public proxy forwards.
//   BAN_REFRESH_MS   how often the ban list is fetched. Default 30000.

const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, 'config.json');
const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const env = process.env;
const flag = (name, fallback) => (env[name] !== undefined ? env[name] === '1' : fallback);

const nginx = flag('NGINX', json.nginx === true);

module.exports = {
  source: fs.existsSync(file) ? 'config.json' : 'the environment',
  versionFromEnv: env.VERSION !== undefined,
  version: env.VERSION || json.version,
  port: env.PORT || json.port,
  nginx,
  collectMetadata: flag('COLLECT_METADATA', json.collectMetadata === true),
  trustLoopbackProxy: nginx || env.TRUST_LOOPBACK_PROXY === '1' || json.trustLoopbackProxy === true,
  game: json.game,
  accountApi: env.ACCOUNT_API_URL || json.accountApi || '',
  serviceKey: env.SERVICE_KEY || '',
  adminPort: env.ADMIN_PORT ? Number(env.ADMIN_PORT) : (json.adminPort || 0),
  adminHost: env.ADMIN_HOST || json.adminHost || '127.0.0.1',
  banRefreshMs: Number(env.BAN_REFRESH_MS || json.banRefreshMs || 30000)
};
