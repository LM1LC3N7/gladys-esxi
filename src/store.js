// -----------------------------------------------------------------------------
// A small JSON file in the writable /data volume, for what the integration
// learns and must keep across restarts:
//   - refusals: an HMAC (keyed with `meta.salt`) of the address, user name
//     and password the server REFUSED, per address: a restart (or a
//     reconnection to Gladys) with the same values does not try again. It is
//     erased as soon as a login works: never a fingerprint of a working
//     password.
//   - pins: the SHA-256 fingerprint of the HTTPS certificate, per address,
//     learned at the first connection (not a secret).
//   - meta: `salt`, a random key generated once for the HMAC above;
//     `pausedUntil|<host:port>`, the end of a pause after HTTP 429 or 5xx (ms);
//     `certChanged|<host:port>`, the fingerprint of another certificate met
//     (lifted by saving the configuration); `attempt|<host:port>`, the last
//     reading attempt { at, failed, delay } (written at most once a minute).
//   - cooldowns: `<host:port>|<instance uuid>` -> when an action was last sent
//     to that VM (ms), the most recent LIMITS.COOLDOWNS only.
// The password, the session cookie, the names of the VMs and any fingerprint
// of a working password are never written here. Writes are atomic (temporary
// file + rename) and queued. When the file cannot be written (no /data during
// development), values stay in memory.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LIMITS } from './constants.js';

const SECTIONS = ['refusals', 'pins', 'meta', 'cooldowns'];
const EMPTY = () => Object.fromEntries(SECTIONS.map((section) => [section, Object.create(null)]));
/** The file is read whole: bounded. */
const MAX_FILE = 256 * 1024;

export class Store {
  #writes = Promise.resolve();

  /** @param {{ filePath: string, logger?: { warn: Function } }} options */
  constructor({ filePath, logger }) {
    this.filePath = filePath;
    this.logger = logger;
    this.data = EMPTY();
    this.loaded = null;
  }

  /** Reads the file once; later calls share the first read. */
  load() {
    this.loaded ??= readFile(this.filePath, 'utf8')
      .then((content) => {
        if (content.length > MAX_FILE) throw new Error('file too large');
        const parsed = JSON.parse(content);
        // Own string values only, into objects without a prototype.
        const pick = (value) => {
          const out = Object.create(null);
          if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
          for (const [k, v] of Object.entries(value)) {
            if (typeof v === 'string' && v && v.length <= 200 && k.length <= 200) out[k] = v;
          }
          return out;
        };
        this.data = Object.fromEntries(
          SECTIONS.map((section) => [section, pick(parsed?.[section])]),
        );
      })
      .catch((err) => {
        if (err.code !== 'ENOENT') {
          this.logger?.warn(`Store unreadable, starting empty: ${err.message}`);
        }
        this.data = EMPTY();
      });
    return this.loaded;
  }

  get(section, key) {
    const values = this.data[section];
    return values && Object.hasOwn(values, key) ? values[key] : null;
  }

  async set(section, key, value) {
    if (value === null || value === undefined) delete this.data[section][key];
    else this.data[section][key] = value;
    if (section === 'cooldowns') this.#trimCooldowns();
    await this.#save();
  }

  /** The most recent cooldowns only (the file stays small). */
  #trimCooldowns() {
    const entries = Object.entries(this.data.cooldowns);
    if (entries.length <= LIMITS.COOLDOWNS) return;
    entries.sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const [key] of entries.slice(LIMITS.COOLDOWNS)) delete this.data.cooldowns[key];
  }

  /** The random key of this installation (created on first use). */
  async salt() {
    let salt = this.get('meta', 'salt');
    if (!salt) {
      salt = randomBytes(32).toString('hex');
      await this.set('meta', 'salt', salt);
    }
    return salt;
  }

  #save() {
    const write = this.#writes.then(() => this.#write());
    this.#writes = write.catch(() => {});
    return write;
  }

  async #write() {
    const tmp = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      this.logger?.warn(`Store not saved, values kept in memory only: ${err.message}`);
    }
  }
}
