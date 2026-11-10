// bans.js -- who this router refuses, from the account service.
//
// GET <ACCOUNT_API_URL>/internal/bans with X-Service-Key answers every active ban as
//   {bans: [{id, subs: ["u:5", "g:12"], scope: "public_play"|"chat"|"all", gameId|null, expires}]}
// where `subs` already includes the guests linked to a banned account and the account linked to a
// banned guest. It is fetched every BAN_REFRESH_MS (30 s), and at once when the admin API is told
// a ban changed, so a ban reaches a live match within one refresh.
//
// A FAILED FETCH KEEPS THE LAST LIST. Dropping every ban because the account service blinked
// would let the banned straight back in; a ban lifted during an outage stays in force a little
// longer instead, which is the safer way to be wrong.
//
// What a scope stops:
//   all          playing at all: refused by Quick Play and kicked from any match.
//   public_play  public matches: refused by Quick Play and kicked from public matches only.
//   chat         chatting: the match is told to mute them.
// A ban with a gameId reaches only that game.
//
// The player token carries the same bans (its `restrict` claim) from when it was made; this list
// is what catches a ban made during the hour a token lives.

class BanCache {
  constructor({ accountApi, serviceKey, refreshMs }) {
    this.enabled = Boolean(accountApi && serviceKey);
    this.url = this.enabled ? new URL('/internal/bans', accountApi) : null;
    this.serviceKey = serviceKey;
    this.refreshMs = refreshMs;
    this.bans = [];
    this.loadedAt = null;
    this.listeners = [];
  }

  start() {
    if (!this.enabled) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  // Called with the list after every successful fetch, so live matches can act on new bans.
  onUpdate(listener) {
    this.listeners.push(listener);
  }

  async refresh() {
    if (!this.enabled) return false;
    try {
      const response = await fetch(this.url, {
        headers: { 'X-Service-Key': this.serviceKey },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error('status ' + response.status);
      /** @type {any} */
      const body = await response.json();
      if (!Array.isArray(body.bans)) throw new Error('no ban list in the answer');
      this.bans = body.bans.filter((b) => b && Array.isArray(b.subs) && ['all', 'public_play', 'chat'].includes(b.scope));
      this.loadedAt = Date.now();
    } catch (err) {
      console.error(`Could not refresh the ban list (keeping ${this.bans.length}): ${err.message}`);
      return false;
    }
    for (const listener of this.listeners) {
      try { listener(this.bans); } catch (err) { console.error('Ban listener failed: ' + err.message); }
    }
    return true;
  }

  // The scopes in force on `sub` in game `gameId`.
  scopesFor(sub, gameId) {
    const now = Date.now();
    const scopes = new Set();
    for (const ban of this.bans) {
      if (ban.gameId && ban.gameId !== gameId) continue;
      if (ban.expires && Date.parse(ban.expires) <= now) continue;
      if (ban.subs.includes(sub)) scopes.add(ban.scope);
    }
    return scopes;
  }

  // Whether `sub` may play in a match of `gameId` that is public or not.
  mayPlay(sub, gameId, isPublic) {
    const scopes = this.scopesFor(sub, gameId);
    return !(scopes.has('all') || (isPublic && scopes.has('public_play')));
  }

  mayChat(sub, gameId) {
    const scopes = this.scopesFor(sub, gameId);
    return !(scopes.has('all') || scopes.has('chat'));
  }

  status() {
    return { enabled: this.enabled, count: this.bans.length, loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null };
  }
}

module.exports = { BanCache };
