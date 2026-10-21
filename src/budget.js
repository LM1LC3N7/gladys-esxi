// -----------------------------------------------------------------------------
// A sliding one-minute window of what was sent: POST /state admits 300 states
// per minute per integration. A publication RESERVES its room before it
// awaits Gladys, so two publications running at the same time never share the
// same room twice (the window holds globally).
// -----------------------------------------------------------------------------

const WINDOW_MS = 60_000;

export class Budget {
  /** @param {{ perMinute: number, now?: () => number }} options */
  constructor({ perMinute, now = Date.now }) {
    this.perMinute = perMinute;
    this.now = now;
    this.entries = []; // [at, count]
  }

  #prune() {
    const since = this.now() - WINDOW_MS;
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop][0] <= since) drop += 1;
    if (drop > 0) this.entries.splice(0, drop);
  }

  used() {
    this.#prune();
    return this.entries.reduce((sum, [, count]) => sum + count, 0);
  }

  remaining() {
    return Math.max(0, this.perMinute - this.used());
  }

  /** Takes up to `wanted` states of room now (synchronously): the count granted. */
  reserve(wanted) {
    const granted = Math.max(0, Math.min(wanted, this.remaining()));
    if (granted > 0) this.entries.push([this.now(), granted]);
    return granted;
  }
}
