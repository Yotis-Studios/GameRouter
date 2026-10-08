// code.js -- short join codes for lobbies
//
// WHY THIS IS ROUTER-SIDE AND NOTHING ELSE
//
// Joining a game is two values: an address and a port. `joinOnlineLobby` reads them off a row
// of the lobby list and hands them to `joinOnlineGame`, and everything after that is the game
// server's business. So a join code only has to resolve to those two -- which makes it an
// HTTP concern, not a protocol one.
//
// That matters more than it sounds. `global.version` is an exact-match compatibility gate:
// bump it and every client is offline until the servers report the same string, so it has to
// ship as a standalone commit coordinated with a deploy. A new packet would drag that in. An
// ADDITIVE endpoint costs none of it -- an older client simply never calls this, and the extra
// `code` field on a game-list row is a key it does not read.
//
// The same reasoning is why nothing here changes the response body of POST /games. That body
// is a bare port string and the client parses it as one; turning it into JSON to carry a code
// would break any client that had not updated in lockstep, which is exactly the class of
// breakage the version gate exists to prevent and this feature was chosen to avoid. The code
// reaches its host through the game-list row instead, which is a field rather than a shape.
//
// THE ALPHABET
//
// Crockford base32: no I, L, O or U. The first three are excluded because somebody is going to
// read a code off a screen and type it, or say it down a voice call, and 1/I/L and 0/O are the
// pairs that get confused doing exactly that. U is excluded because leaving it in lets four
// random characters spell things the host did not choose to say.
//
// `normalise` then maps the confusable characters back rather than rejecting them, so a player
// who types the letter O where the code shows a zero is simply right. Rejecting that input
// would be technically correct and would read as the code not working.

const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 4;

// 32^4 is a million codes, against a server whose memory-based cap is a few dozen concurrent
// games. Collisions are therefore rare rather than impossible, and are handled by retrying
// rather than by being ruled out.
const MAX_ATTEMPTS = 100;

function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return out;
}

/// A code not already in `taken`, or null if the space is somehow saturated.
///
/// Null rather than a throw, because failing to mint a code must not fail the host request.
/// A lobby with no code is still a lobby -- it is in the list like every other one, and the
/// code was only ever a shortcut to it.
function generateCode(taken) {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const code = randomCode();
    if (!taken[code]) return code;
  }
  console.error(`Could not mint a unique join code in ${MAX_ATTEMPTS} attempts.`);
  return null;
}

/// What a player typed, turned into what the router stored -- or null if it cannot be a code.
///
/// Null rather than a best guess for anything of the wrong length, or holding characters the
/// alphabet does not contain, so a lookup for junk is a 404 rather than a lookup for some
/// other lobby.
function normalise(raw) {
  if (typeof raw !== 'string') return null;

  const cleaned = raw.trim().toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');

  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

module.exports = { generateCode, normalise, ALPHABET, CODE_LENGTH };
