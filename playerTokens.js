// playerTokens.js -- who is asking, from a Yotis Online player token.
//
// The account service (yo-account-api lib/playerTokens.js) signs player tokens with Ed25519 and
// publishes the public key at /api/.well-known/jwks. The router checks them offline against that
// key: it can verify a token but never mint one, and it makes no call to the account service per
// request. verify() is that file's, copied as it is (it is kept dependency-free for this).
//
// Claims: iss "yotisonline", sub "u:<id>" (an account) or "g:<id>" (a guest), kind, name, role
// (staff only), restrict (active bans when the token was made), iat, exp. About an hour long.
//
// The key set is kept five minutes and fetched again early when a token names a key it has not
// seen, at most every ten seconds, so a key rotation reaches the router without a restart.

const crypto = require('crypto');

const ISSUER = 'yotisonline';

function verify(token, jwks, now = Math.floor(Date.now() / 1000)) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new Error('Malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  const key = header.alg === 'EdDSA' && jwks.keys.find((k) => k.kid === header.kid && k.crv === 'Ed25519');
  if (!key) throw Object.assign(new Error('Unknown key'), { unknownKey: true });
  const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
  if (!crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]), publicKey, Buffer.from(parts[2], 'base64url'))) throw new Error('Bad signature');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (claims.iss !== ISSUER || typeof claims.sub !== 'string' || !(claims.exp > now)) throw new Error('Expired or foreign token');
  return claims;
}

// A sub the platform issues: an account or a guest. Later "b:" bots and "s:" services, which
// Quick Play does not seat.
const PLAYER_SUB = /^[ug]:[1-9][0-9]{0,9}$/;

// The soonest a token naming an unknown key fetches the set again (JWKS_REFETCH_MS for tests).
const REFETCH_MS = process.env.JWKS_REFETCH_MS !== undefined ? Number(process.env.JWKS_REFETCH_MS) : 10000;

function createPlayerTokens(accountApi) {
  if (!accountApi) return null;
  let cached = null;
  let fetchedAt = 0;
  // Called with the new key set whenever it changes: every live match verifies tokens itself
  // (shikikan, ROUTER_JWKS) and is sent the new set.
  const listeners = [];
  async function keys(force) {
    const age = Date.now() - fetchedAt;
    if (cached && (force ? age < REFETCH_MS : age < 300000)) return cached;
    try {
      const response = await fetch(new URL('/api/.well-known/jwks', accountApi), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('JWKS ' + response.status);
      const fresh = await response.json();
      const changed = cached && JSON.stringify(fresh) !== JSON.stringify(cached);
      cached = fresh;
      fetchedAt = Date.now();
      if (changed) for (const listener of listeners) listener(cached);
    } catch (err) {
      console.error('Could not fetch the player token key set: ' + err.message);
      if (!cached) return null;
    }
    return cached;
  }
  // The claims, or {status, message} for the client.
  async function check(header) {
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
    if (!token) return { status: 401, message: 'A Yotis Online player token is required.' };
    const first = await keys(false);
    if (!first) return { status: 503, message: 'Player sign-in is unavailable. Please try again.' };
    let claims;
    try {
      claims = verify(token, first);
    } catch (err) {
      try {
        if (!err.unknownKey) throw err;
        const again = await keys(true);
        if (!again) throw err;
        claims = verify(token, again);
      } catch {
        return { status: 401, message: 'Please sign in again.' };
      }
    }
    if (!PLAYER_SUB.test(claims.sub)) return { status: 403, message: 'Only players can use Quick Play.' };
    return { claims };
  }
  return { check, keys, onChange: (listener) => listeners.push(listener) };
}

module.exports = { createPlayerTokens, verify, ISSUER, PLAYER_SUB };
