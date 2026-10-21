// -----------------------------------------------------------------------------
// EsxiApp: the integration. One ESXi host or one vCenter, its hosts,
// datastores and virtual machines.
//
//   start(config)  (re)connects: the server read, Discovery published, the
//                  loop started
//   loop           every `poll_interval` s (60 by default): one
//                  RetrievePropertiesEx (paged) -> hosts, datastores, VMs
//   VM actions     Start, Shut down (guest), Restart (guest): `button`s,
//                  each refused unless its option is on; the VM read again
//                  first (the same instance UUID? which power state?), the
//                  option checked again right before sending, one request
//                  never retried, one action per VM per minute. Never an
//                  action on a host.
//   failures       credentials refused stop everything until the
//                  configuration is saved (ESXi locks an account after a few
//                  failures); another HTTPS certificate than the pinned one
//                  stops before anything is written; HTTP 429 and 5xx pause
//                  every request (bounded, kept in /data); anything else is
//                  retried, never faster than the poll interval, doubling up
//                  to 30 min
//
// Never faster than the interval: the time of the last attempt is kept (in
// memory, and in /data at most once a minute); a restart of the container, a
// reconnection to Gladys, the test button, the scan and a configuration saved
// unchanged all wait for it. Only a configuration saved with other values
// reads at once. A reconnection during a reading never starts a second one.
//
// The loop is one chain of timers: halt() bumps an epoch, and a run of an
// older epoch never schedules itself again. A reading of a replaced client
// (another configuration) publishes nothing and sets no status. Neither the
// password, nor the session cookie, nor the names of the VMs are logged.
// -----------------------------------------------------------------------------

import { createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { normalizeConfig } from './config.js';
import {
  COMMAND,
  FEATURES,
  INTERVALS,
  LIMITS,
  PRESSED,
  STORE_FILE,
  VM_ACTIONS,
} from './constants.js';
import {
  buildDatastoreDevice,
  buildHostDevice,
  buildVmDevice,
  createdDevices,
  datastoreIds,
  hostIds,
  parseExternalId,
  vmIds,
} from './devices.js';
import { T, join as joinTexts, reasonOf } from './i18n.js';
import { Store } from './store.js';
import { VsphereClient } from './vsphere/client.js';
import { CODES, isCredentialsRefused } from './vsphere/errors.js';
import { httpRequest } from './vsphere/http.js';
import { parseInventory } from './vsphere/parse.js';

/** The "Test the connection" button waits 30 s: answer before. */
const TEST_BUDGET_MS = 25_000;
/** A whole reading (login and pages included). */
const READ_BUDGET_MS = 45_000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** The value of a state entry, number or text, as one comparable key. */
const valueOf = (s) => (s.text !== undefined ? `t:${s.text}` : `s:${s.state}`);
const round1 = (n) => Math.round(n * 10) / 10;
const GB = 1e9;
const MIB = 1024 * 1024;
const toolsRunning = (tools) =>
  tools === 'guestToolsRunning' || tools === 'guestToolsExecutingScripts';

/** What Discovery shows: sent again when it changes. */
const discoveredKeyOf = (inv) =>
  JSON.stringify([
    inv.hosts.map((h) => [h.id, h.name, h.vendor, h.model]),
    inv.datastores.map((d) => [d.id, d.name, d.type]),
    inv.vms.map((v) => [v.uuid, v.name]),
  ]);

const EMPTY = () => ({ hosts: [], datastores: [], vms: [], skipped: 0 });

export class EsxiApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTPS transport (tests inject a fake server)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'esxi' }),
    request = httpRequest,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.timers = timers;
    this.store = new Store({ filePath: join(dataDir, STORE_FILE), logger });
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now });
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    this.handles = new Set();
    this.queue = Promise.resolve();
    this.lastStatus = null;
    /** The connection key of the last start (in memory only). */
    this.lastConnectionKey = null;
    /** The last good reading { key, at, inventory, about }; in memory only. */
    this.known = null;
    /** The last failure { key, message }; in memory only (its time is in `attempts`). */
    this.lastFailure = null;
    /** host:port -> { at, failed, delay }: the last reading attempt (mirrored in /data). */
    this.attempts = new Map();
    this.attemptWrittenAt = -Infinity;
    this.flushHandle = null;
    /** The server key whose attempt is not written to /data yet. */
    this.dirtyAttempt = null;
    /** Values last accepted by Gladys (feature -> value), to budget only changes. */
    this.published = new Map();
    /** The reading in flight and its client: one at a time (loop, Discovery, start). */
    this.reading = null;
    this.readingClient = null;
    /** The VM action being sent. */
    this.inFlight = null;
    /** The last pause asked by the server { key, until }, in memory (a /data that cannot be written). */
    this.pauseMemory = null;
    this.reset();
  }

  reset() {
    this.online = false;
    this.blocked = false;
    this.pausedUntil = 0;
    this.retryDelay = this.minRetry();
    this.inventory = EMPTY();
    this.about = null;
    this.discoveredKey = null;
    this.transports = new Map();
    this.published.clear();
  }

  /** A failure is never read again faster than the poll interval. */
  minRetry() {
    return Math.max(INTERVALS.RETRY_MIN_MS, (this.config?.pollSeconds ?? 60) * 1000);
  }

  pollMs() {
    return this.config.pollSeconds * 1000;
  }

  // --- Keys ----------------------------------------------------------------------

  /** `host:port` of the server: the key of its refusal, pause, certificate, attempts. */
  serverKey(config = this.config) {
    return `${config.host}:${config.port}`;
  }

  /** What a client and a reading belong to (a SHA-256 of the account, in memory only). */
  connectionKey(config = this.config) {
    return createHash('sha256')
      .update(
        JSON.stringify([config.host, config.port, config.pin, config.username, config.password]),
      )
      .digest('hex');
  }

  /** The values a REFUSAL is about (HMAC with the salt of /data), written only once refused. */
  async refusalKey(config) {
    return createHmac('sha256', await this.store.salt())
      .update(JSON.stringify([this.serverKey(config), config.username, config.password]))
      .digest('hex');
  }

  pauseKey(config = this.config) {
    return `pausedUntil|${this.serverKey(config)}`;
  }

  certKey(config = this.config) {
    return `certChanged|${this.serverKey(config)}`;
  }

  attemptKey(config = this.config) {
    return `attempt|${this.serverKey(config)}`;
  }

  cooldownKey(uuid) {
    return `${this.serverKey()}|${uuid}`;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Run `task` after every start / restart already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * saved the configuration: credentials refused earlier are tried again,
   * and the server is read at once when the values changed. A changed
   * certificate is NEVER accepted by a save: only by its fingerprint typed in
   * the configuration, or by the "Trust the new certificate" button
   * (`trusted`, which also reads at once). Nothing else (a reconnection to
   * Gladys, the test button, the same values saved again) reads faster than
   * the interval, nor lifts a pause asked by the server.
   */
  start(rawConfig, { force = false, trusted = false } = {}) {
    return this.enqueue(() => this.run(rawConfig, { force, trusted }));
  }

  /** Gladys went away: the timers stop; the client and a reading in flight are kept. */
  async stop() {
    this.generation += 1;
    this.halt();
  }

  /** The container stops: the attempt written, the session logged out (best effort). */
  async shutdown() {
    await this.stop();
    await this.flushAttempt();
    const client = this.client;
    this.client = null;
    await client?.logout();
    client?.close();
  }

  /** Clear every timer; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
  }

  /** A new configuration: the old client is closed (its session logged out in the background). */
  dropClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    // Only the Logout may still go out: a reading in flight never logs in
    // again with the old values.
    client.beginClose();
    client
      .logout()
      .catch(() => {})
      .finally(() => client.close());
  }

  async run(rawConfig, { force = false, trusted = false } = {}) {
    this.halt();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    const config = normalizeConfig(rawConfig);
    // The same values as the previous start (a reconnection, the test button,
    // the configuration saved unchanged): never a reading before the interval.
    const sameValues = this.lastConnectionKey === this.connectionKey(config);
    this.lastConnectionKey = this.connectionKey(config);
    const sameClient = sameValues && this.client?.key === this.connectionKey(config);
    // A pause known in memory (even if /data could not keep it) outlives the restart.
    const memoryPause = this.pauseMemory;
    const previous = this.inventory;
    this.config = config;
    this.reset();
    // The core keeps the status and Discovery in memory: a start (a
    // reconnection to Gladys included) always sends them again.
    this.lastStatus = null;
    await this.store.load();
    if (generation !== this.generation) return;

    const invalid = this.configError(config);
    if (invalid) {
      this.dropClient();
      return this.stopWith(invalid);
    }
    if (!sameClient) {
      this.dropClient();
      if (this.known && this.known.key !== this.connectionKey(config)) this.known = null;
    } else {
      this.inventory = previous;
    }
    const key = this.serverKey(config);
    const refusal = await this.refusalKey(config);
    // Credentials the server refused with these very values are not tried
    // again before the configuration is saved.
    const refused = this.store.get('refusals', key);
    if (refused && refused === refusal && !force) {
      this.blocked = true;
      this.logger.warn('Credentials refused earlier: not tried again');
      return this.stopWith(T.status.credentialsRefused);
    }
    if (refused) await this.store.set('refusals', key, null);
    // Another certificate met: nothing is sent, whatever is saved, until the
    // user vouches for exactly the certificate shown in the status: its
    // fingerprint typed in the configuration, or the "Trust the new
    // certificate" button (which pins it and clears this mark). Never a new
    // trust on first use.
    const changed = this.store.get('meta', this.certKey());
    if (changed) {
      if (config.pin !== changed) {
        this.blocked = true;
        this.logger.warn('The HTTPS certificate of the server changed: nothing sent');
        return this.stopWith(this.certificateMessage(changed));
      }
      await this.store.set('pins', key, changed);
      await this.store.set('meta', this.certKey(), null);
      // The client still holds the old pin (its logout goes nowhere: refused before writing).
      this.dropClient();
      this.logger.info('The new HTTPS certificate of the server was typed in the configuration');
    }
    if (trusted || (force && !sameValues)) {
      // Other values saved: the last attempt was about the old ones.
      this.attempts.delete(key);
      this.lastFailure = null;
    }

    if (!this.client) {
      const typed = config.pin;
      this.client = new VsphereClient({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        pin: typed ?? this.store.get('pins', key),
        onPin: async (fingerprint) => {
          await this.store.set('pins', key, fingerprint);
          this.logger.info('HTTPS certificate of the server learned');
        },
        request: this.request,
        now: this.now,
        timers: this.timers,
      });
      this.client.key = this.connectionKey(config);
      this.logger.info(`Using the vSphere API at https://${config.host}:${config.port}/sdk`);
    }

    // A pause (HTTP 429 or 5xx) outlives a restart, a reconnection to Gladys
    // and a saved configuration; its end is capped (a clock jump, a file
    // written by hand) and the capped end written back.
    let stored = Number(this.store.get('meta', this.pauseKey())) || 0;
    if (memoryPause?.key === this.pauseKey()) stored = Math.max(stored, memoryPause.until);
    const pausedUntil = Math.min(stored, this.now() + INTERVALS.BUSY_MAX_MS);
    if (pausedUntil < stored) await this.store.set('meta', this.pauseKey(), String(pausedUntil));
    if (this.now() < pausedUntil) {
      this.pausedUntil = pausedUntil;
      const delay = pausedUntil - this.now();
      await this.restoreKnown();
      await this.publishTransports();
      await this.setStatus(false, T.status.paused(delay));
      this.schedule(delay, () => this.connect(generation));
      return;
    }

    // A reading of this very client is in flight (a reconnection to Gladys
    // during a reading): it is this start's reading, never a second one.
    if (this.reading && this.readingClient === this.client) {
      await this.restoreKnown();
      await this.publishTransports();
      await this.setStatus(false, T.status.reading);
      this.follow(this.reading, generation);
      return;
    }

    // Never faster than the interval after the last attempt (a restart of the
    // container included), unless other values were just saved.
    const attempt = await this.lastAttempt();
    if (attempt && !(trusted || (force && !sameValues))) {
      const at = Math.min(attempt.at, this.now());
      // A success waits for the interval; a failure, or an attempt read back
      // from /data (its outcome unknown), for its retry delay.
      const waitFor = attempt.failed === false ? this.pollMs() : attempt.delay;
      const wait = Math.min(at + waitFor - this.now(), INTERVALS.RETRY_MAX_MS);
      if (attempt.failed !== false) this.retryDelay = attempt.delay;
      if (wait > 0) {
        const fresh = this.freshKnown();
        if (!attempt.failed && fresh) {
          await this.resume(fresh, generation, wait);
          return;
        }
        await this.restoreKnown();
        await this.publishTransports();
        const failure = this.lastFailure?.key === this.connectionKey() ? this.lastFailure : null;
        await this.setStatus(
          false,
          attempt.failed === true
            ? (failure?.message ?? T.status.failedBefore(wait))
            : T.status.waiting(wait),
        );
        if (generation !== this.generation) return;
        this.schedule(wait, () => this.connect(generation));
        return;
      }
    }
    await this.connect(generation);
  }

  /** Another certificate (its fingerprint shown): learned before, or not the typed one. */
  certificateMessage(fingerprint, config = this.config) {
    return config.pin
      ? T.status.certificateNotTyped(fingerprint)
      : T.status.certificateChanged(fingerprint);
  }

  /**
   * "Trust the new certificate": pins exactly the certificate refused last
   * (the one the status shows), then reads at once. Never a certificate that
   * was not shown, never a new trust on first use.
   */
  async trustCertificate() {
    await this.store.load();
    const seen = this.store.get('meta', this.certKey());
    if (!seen) return T.trust.nothing;
    if (this.config.pin && this.config.pin !== seen) return T.trust.typed(seen);
    await this.store.set('pins', this.serverKey(), seen);
    await this.store.set('meta', this.certKey(), null);
    this.logger.info('The new HTTPS certificate of the server was trusted by the user');
    // The client holds the old pin: replaced.
    this.dropClient();
    await this.within(
      // The configuration read when the task runs, after any save still
      // queued: never an older one.
      this.enqueue(() => this.run(this.rawConfig, { trusted: true })),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    const last = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
    return last ? joinTexts(T.trust.done(seen), last) : T.trust.done(seen);
  }

  /** The status of a configuration that cannot be used, or null. */
  configError(config) {
    if (config.hostError) {
      return config.hostError === 'missing' ? T.status.hostMissing : T.status.hostInvalid;
    }
    if (config.portInvalid) return T.status.portInvalid;
    if (config.pinInvalid) return T.status.pinInvalid;
    if (!config.username) return T.status.usernameMissing;
    if (config.usernameInvalid) return T.status.usernameInvalid;
    if (!config.password) return T.status.missingPassword;
    if (config.passwordInvalid) return T.status.passwordInvalid;
    return null;
  }

  /** The last good reading of these values, when younger than one poll interval; else null. */
  freshKnown() {
    const known = this.known;
    if (!known || known.key !== this.connectionKey()) return null;
    const age = this.now() - known.at;
    return age >= 0 && age < this.pollMs() ? known : null;
  }

  /** Online again from the last reading: Discovery, states, badges, status, the loop. */
  async resume(known, generation, wait) {
    const epoch = this.epoch;
    this.inventory = known.inventory;
    this.about = known.about;
    this.online = true;
    this.discoveredKey = discoveredKeyOf(this.inventory);
    await this.publishDiscovered();
    if (generation !== this.generation) return;
    await this.publishDeviceStates();
    await this.publishTransports();
    if (generation !== this.generation) return;
    await this.setStatus(true, this.okMessage());
    // A failure handled meanwhile (it halted) owns the next reading: one chain only.
    if (!this.current(generation, epoch)) return;
    this.scheduleLoop(wait, generation);
  }

  /** Discovery again from the last reading (a pause, a wait), or nothing. */
  async restoreKnown() {
    const { hosts, datastores, vms } = this.inventory;
    const empty = hosts.length + datastores.length + vms.length === 0;
    if (empty && this.known?.key === this.connectionKey()) {
      this.inventory = this.known.inventory;
      this.about = this.known.about;
    }
    await this.publishDiscovered();
  }

  /** Stopped before any request (configuration, refusal, certificate): status and badges. */
  async stopWith(message) {
    // Discovery too: the core forgets it at every reconnection.
    await this.publishDiscovered();
    await this.publishTransports();
    await this.setStatus(false, message);
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(async () => {
      this.handles.delete(handle);
      try {
        await task();
      } catch (err) {
        this.logger.error(`Loop failed: ${err?.message}`);
      }
    }, delay);
    this.handles.add(handle);
    return handle;
  }

  scheduleLoop(delay, generation) {
    const epoch = this.epoch;
    this.schedule(delay, () => this.loop(generation, epoch));
  }

  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  /** A reading started earlier, followed by this start: the loop after it, or its failure. */
  follow(reading, generation) {
    const epoch = this.epoch;
    reading.then(
      () => {
        if (this.current(generation, epoch)) this.scheduleLoop(this.pollMs(), generation);
      },
      async (err) => {
        if (this.current(generation, epoch)) await this.failed(err, generation);
      },
    );
  }

  /** The first reading, then the loop. Never throws. */
  async connect(generation) {
    if (!this.client || generation !== this.generation) return;
    // A failure handled meanwhile (a VM action answered 5xx: it halts and
    // schedules its own retry) owns the next reading: one chain only.
    const epoch = this.epoch;
    if (this.reading && this.readingClient === this.client) {
      this.follow(this.reading, generation);
      return;
    }
    try {
      await this.refresh({ publish: true });
      if (!this.current(generation, epoch)) return;
      const inv = this.inventory;
      this.logger.info(
        `The server answers: ${inv.hosts.length} host(s), ${inv.datastores.length} datastore(s), ${inv.vms.length} VM(s)`,
      );
    } catch (err) {
      if (this.current(generation, epoch)) await this.failed(err, generation);
      return;
    }
    this.scheduleLoop(this.pollMs(), generation);
  }

  async loop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    // An attempt made meanwhile (the scan): the loop waits for its interval.
    const attempt = this.attempts.get(this.serverKey());
    const since = attempt ? this.now() - attempt.at : Infinity;
    if (since >= 0 && since < this.pollMs()) {
      this.scheduleLoop(this.pollMs() - since, generation);
      return;
    }
    if (this.paused()) {
      // A pause met on another path (a command): no reading before its end.
      this.scheduleLoop(this.pausedUntil - this.now(), generation);
      return;
    }
    if (this.reading) {
      // A reading is in flight (Discovery): it is this round's.
      await this.reading.catch(() => {});
      if (this.current(generation, epoch)) this.scheduleLoop(this.pollMs(), generation);
      return;
    }
    try {
      await this.refresh({ publish: false });
    } catch (err) {
      if (this.current(generation, epoch)) await this.failed(err, generation);
      return;
    }
    if (this.current(generation, epoch)) this.scheduleLoop(this.pollMs(), generation);
  }

  // --- Attempts (never faster than the interval, across restarts) -------------------

  /** The last attempt for this server: memory first, else /data. */
  async lastAttempt() {
    const key = this.serverKey();
    if (this.attempts.has(key)) return this.attempts.get(key);
    let saved;
    try {
      saved = JSON.parse(this.store.get('meta', this.attemptKey()) ?? 'null');
    } catch {
      saved = null;
    }
    const at = Number(saved?.at);
    const delay = Number(saved?.delay);
    if (!Number.isFinite(at) || at <= 0) return null;
    // Read back from /data: its outcome is unknown (`failed: null`), the
    // retry delay it was started with applies.
    const attempt = {
      at: Math.min(at, this.now()),
      failed: null,
      delay: clamp(
        Number.isFinite(delay) ? delay : this.minRetry(),
        this.minRetry(),
        INTERVALS.RETRY_MAX_MS,
      ),
    };
    this.attempts.set(key, attempt);
    return attempt;
  }

  /**
   * An attempt. Its START is written to /data (`{ at, delay }`, the retry
   * delay it runs with: a container restart, even a crash during the
   * reading, waits for it), at most once a minute (a later write deferred,
   * never dropped). Its outcome only lives in memory: the start already
   * carries the longest wait.
   */
  async noteAttempt(at, failed, delay, { persist = false, config = this.config } = {}) {
    const key = this.serverKey(config);
    this.attempts.set(key, { at, failed, delay });
    if (!persist) return;
    this.dirtyAttempt = { key, value: JSON.stringify({ at, delay }) };
    const due = this.attemptWrittenAt + INTERVALS.ATTEMPT_WRITE_MS - this.now();
    if (due <= 0) {
      await this.flushAttempt();
    } else if (!this.flushHandle) {
      this.flushHandle = this.timers.setTimeout(() => {
        this.flushHandle = null;
        return this.flushAttempt().catch(() => {});
      }, due);
    }
  }

  async flushAttempt() {
    if (this.flushHandle) {
      this.timers.clearTimeout(this.flushHandle);
      this.flushHandle = null;
    }
    const dirty = this.dirtyAttempt;
    if (!dirty) return;
    this.dirtyAttempt = null;
    this.attemptWrittenAt = this.now();
    await this.store.set('meta', `attempt|${dirty.key}`, dirty.value);
  }

  // --- Failures ----------------------------------------------------------------------

  /** HTTP 429 or 5xx: a bounded pause of every request, kept in /data. Returns its length or 0. */
  async pauseFor(err) {
    if (err?.code !== CODES.HTTP) return 0;
    let delay;
    if (err.status === 429) {
      delay = clamp(
        err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
        Math.max(INTERVALS.BUSY_MIN_MS, this.pollMs()),
        INTERVALS.BUSY_MAX_MS,
      );
    } else if (err.status >= 500) {
      delay = clamp(err.retryAfterMs ?? this.retryDelay, this.retryDelay, INTERVALS.BUSY_MAX_MS);
    } else {
      return 0;
    }
    this.pausedUntil = this.now() + delay;
    this.pauseMemory = { key: this.pauseKey(), until: this.pausedUntil };
    await this.store.set('meta', this.pauseKey(), String(this.pausedUntil));
    return delay;
  }

  /** A reading failed: final refusal, certificate, a pause, or a retry with a growing delay. */
  async failed(err, generation) {
    if (generation !== this.generation) return;
    // The configuration of the client that failed, frozen: a configuration
    // saved meanwhile is never marked with this failure (never the HMAC of
    // its password as "refused", never its address as "certificate changed").
    const config = this.config;
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    // Another failure or a new start handled meanwhile (it halted again)
    // owns the next reading: this one writes nothing more and never
    // schedules a second chain.
    const epoch = this.epoch;
    // A new start or another failure took over (the block this call sets
    // itself does not count).
    const replaced = () => generation !== this.generation || epoch !== this.epoch;
    const superseded = () => replaced() || this.blocked;
    await this.publishTransports();
    if (superseded()) return;
    const startedAt = this.attempts.get(this.serverKey(config))?.at ?? this.now();
    if (isCredentialsRefused(err)) {
      const refusal = await this.refusalKey(config);
      if (superseded()) return;
      this.blocked = true;
      this.known = null;
      this.noteAttempt(startedAt, true, this.retryDelay, { config });
      await this.store.set('refusals', this.serverKey(config), refusal);
      this.logger.warn(
        'The server refused the user name or the password: not retried until the configuration is saved',
      );
      // A configuration saved during the write owns the status now.
      if (replaced()) return;
      await this.setStatus(false, T.status.credentialsRefused);
      return;
    }
    if (err?.code === CODES.CERTIFICATE && err.fingerprint) {
      this.blocked = true;
      this.known = null;
      this.noteAttempt(startedAt, true, this.retryDelay, { config });
      // The fingerprint met (not a secret): shown in the status, and the
      // only one the user can vouch for.
      await this.store.set('meta', this.certKey(config), err.fingerprint);
      this.logger.warn(
        'The HTTPS certificate of the server is not the pinned one: nothing sent, stopped until the user trusts it',
      );
      if (replaced()) return;
      await this.setStatus(false, this.certificateMessage(err.fingerprint, config));
      return;
    }
    let delay = this.retryDelay;
    const paused = await this.pauseFor(err);
    if (superseded()) return;
    if (paused > 0) delay = paused;
    if (err?.status !== 429)
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
    if (wasOnline || delay === this.minRetry() || paused > 0) {
      // A VsphereError message never holds a secret nor a name; anything
      // else is reduced to its code.
      const what = err?.name === 'VsphereError' ? err.message : String(err?.code ?? 'error');
      this.logger.warn(`The server fails: ${what}`);
    }
    const message = this.errorMessage(err, delay);
    this.lastFailure = { key: this.connectionKey(config), message };
    await this.noteAttempt(startedAt, true, delay, { config });
    if (superseded()) return;
    await this.setStatus(false, message);
    if (superseded()) return;
    this.schedule(delay, () => this.connect(generation));
  }

  errorMessage(err, delay) {
    if (err?.status === 429) return T.status.busy(delay);
    if (err?.code === CODES.HTTP && err.status >= 500)
      return T.status.serverError(err.status, delay);
    switch (err?.code) {
      case CODES.ACCESS:
        return T.status.access(delay);
      case CODES.REDIRECT:
        return T.status.redirect(delay);
      case CODES.BAD_ANSWER:
      case CODES.HTTP:
        return T.status.notVsphere(delay);
      case CODES.UNREACHABLE:
      case CODES.TIMEOUT:
        return T.status.unreachable(err, delay);
      default:
        return T.status.failing(err, delay);
    }
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Reading -------------------------------------------------------------------------

  /** Read the server, publish it. Throws when it cannot be read. */
  refresh(options) {
    const client = this.client;
    const reading = this.read(client, options).finally(() => {
      if (this.reading === reading) {
        this.reading = null;
        this.readingClient = null;
      }
    });
    this.reading = reading;
    this.readingClient = client;
    return reading;
  }

  async read(client, { publish }) {
    if (!client) return;
    // A reading that ends after the client was replaced (another
    // configuration) publishes nothing and sets no status.
    const stale = () => client !== this.client;
    const started = this.now();
    // Known at once in memory (the scan, a reconnection) and in /data (a
    // restart, even a crash, during the reading waits for it).
    await this.noteAttempt(started, null, this.retryDelay, { persist: true });
    if (stale()) return;
    const result = await client.inventory(started + READ_BUDGET_MS);
    if (stale()) return;
    // A pause asked earlier is over (the reading worked): forget it.
    this.pauseMemory = null;
    if (this.store.get('meta', this.pauseKey())) {
      await this.store.set('meta', this.pauseKey(), null);
      if (stale()) return;
    }
    this.pausedUntil = 0;
    // A login worked: no fingerprint of a refused password is kept any more.
    if (this.store.get('refusals', this.serverKey())) {
      await this.store.set('refusals', this.serverKey(), null);
      if (stale()) return;
    }
    const inventory = parseInventory(result.objects);
    if (result.truncated || inventory.skipped > 0) {
      this.logger.debug(
        `Objects left out: ${inventory.skipped}${result.truncated ? ', more pages' : ''}`,
      );
    }
    this.inventory = inventory;
    this.about = result.about;
    this.online = true;
    this.retryDelay = this.minRetry();
    this.lastFailure = null;
    this.known = { key: this.connectionKey(), at: started, inventory, about: result.about };
    await this.noteAttempt(started, false, 0);
    if (stale()) return;

    const discoveredKey = discoveredKeyOf(inventory);
    if (publish || discoveredKey !== this.discoveredKey) await this.publishDiscovered();
    if (stale()) return;
    this.discoveredKey = discoveredKey;
    await this.publishDeviceStates();
    if (stale()) return;
    await this.publishTransports();
    if (stale()) return;
    await this.setStatus(true, this.okMessage());
  }

  okMessage() {
    const { hosts, vms } = this.inventory;
    return T.status.ok({
      server: this.about?.fullName ?? null,
      hosts: hosts.length,
      vms: vms.length,
      running: vms.filter((v) => v.power === 'poweredOn').length,
    });
  }

  /** Never throws: a refusal of Gladys is not a failure of the server. */
  async publishDiscovered() {
    const { hosts, datastores, vms } = this.inventory;
    const devices = [
      ...hosts.map((h) => buildHostDevice(this.gladys, h)),
      ...datastores.map((d) => buildDatastoreDevice(this.gladys, d)),
      ...vms.map((v) => buildVmDevice(this.gladys, v)),
    ];
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /**
   * Discovery (scan button): read again only when connected and the last
   * attempt is older than the poll interval (never faster), else what is known.
   */
  async publishDiscovery() {
    if (this.reading) {
      await this.reading.catch(() => {});
      await this.publishDiscovered();
      return;
    }
    const attempt = this.attempts.get(this.serverKey());
    const due = !attempt || this.now() - attempt.at >= this.pollMs();
    if (this.online && due && !this.paused() && this.client && !this.blocked) {
      const generation = this.generation;
      const done = await this.refresh({ publish: true }).then(
        () => true,
        async (err) => {
          if (generation !== this.generation) return true;
          await this.failed(err, generation);
          return false;
        },
      );
      if (done) return;
    }
    await this.publishDiscovered();
  }

  /** The states of the created devices. */
  statesOf() {
    const created = createdDevices(this.gladys);
    const states = [];
    const number = (id, value) => {
      if (value !== null && value !== undefined && Number.isFinite(value)) {
        states.push({ device_feature_external_id: id, state: value });
      }
    };
    const text = (id, value) => {
      if (typeof value === 'string' && value) {
        states.push({ device_feature_external_id: id, text: value.slice(0, LIMITS.TEXT_LENGTH) });
      }
    };
    const flag = (value) => (value === null || value === undefined ? null : value ? 1 : 0);
    const percent = (part, whole) =>
      part === null || !whole ? null : round1(clamp((part / whole) * 100, 0, 100));
    const { hosts, datastores, vms } = this.inventory;
    const hostById = new Map(hosts.map((h) => [h.id, h]));

    for (const { id } of created.hosts) {
      const h = hostById.get(id);
      if (!h) continue;
      const ids = hostIds(this.gladys, id);
      const up = h.connection === 'connected';
      number(ids.feature(FEATURES.CONNECTED), h.connection === null ? null : up ? 1 : 0);
      number(ids.feature(FEATURES.MAINTENANCE), flag(h.maintenance));
      if (up) {
        const capacityMhz = h.cpuMhz && h.cores ? h.cpuMhz * h.cores : null;
        number(ids.feature(FEATURES.CPU_USAGE), percent(h.cpuUsedMhz, capacityMhz));
        const usedBytes = h.memoryUsedMb === null ? null : h.memoryUsedMb * MIB;
        number(ids.feature(FEATURES.MEMORY_USAGE), percent(usedBytes, h.memoryBytes));
        number(
          ids.feature(FEATURES.MEMORY_USED),
          usedBytes === null ? null : round1(usedBytes / GB),
        );
        number(
          ids.feature(FEATURES.UPTIME),
          h.uptimeSeconds === null ? null : round1(h.uptimeSeconds / 3600),
        );
        number(
          ids.feature(FEATURES.VMS_RUNNING),
          vms.filter((v) => v.host === id && v.power === 'poweredOn').length,
        );
      }
      number(
        ids.feature(FEATURES.MEMORY_TOTAL),
        h.memoryBytes === null ? null : round1(h.memoryBytes / GB),
      );
      text(ids.feature(FEATURES.HEALTH), h.status);
      text(ids.feature(FEATURES.VERSION), h.product);
    }
    const dsById = new Map(datastores.map((d) => [d.id, d]));
    for (const { id } of created.datastores) {
      const d = dsById.get(id);
      if (!d) continue;
      const ids = datastoreIds(this.gladys, id);
      number(ids.feature(FEATURES.ACCESSIBLE), flag(d.accessible));
      if (d.capacity && d.free !== null && d.free <= d.capacity) {
        number(ids.feature(FEATURES.USAGE), percent(d.capacity - d.free, d.capacity));
        number(ids.feature(FEATURES.FREE), round1(d.free / GB));
      }
      if (d.capacity) number(ids.feature(FEATURES.CAPACITY), round1(d.capacity / GB));
    }
    const vmByUuid = new Map(vms.map((v) => [v.uuid, v]));
    for (const { id } of created.vms) {
      const v = vmByUuid.get(id);
      if (!v) continue;
      const ids = vmIds(this.gladys, id);
      const running = v.power === 'poweredOn';
      number(ids.feature(FEATURES.RUNNING), v.power === null ? null : running ? 1 : 0);
      text(ids.feature(FEATURES.POWER_STATE), v.power);
      number(
        ids.feature(FEATURES.TOOLS_RUNNING),
        v.tools === null ? null : toolsRunning(v.tools) ? 1 : 0,
      );
      text(ids.feature(FEATURES.HEALTH), v.status);
      if (v.power === null) continue;
      const host = hostById.get(v.host);
      const capacityMhz = host?.cpuMhz && v.cpus ? host.cpuMhz * v.cpus : null;
      number(ids.feature(FEATURES.CPU_USAGE), running ? percent(v.cpuUsedMhz, capacityMhz) : 0);
      number(
        ids.feature(FEATURES.MEMORY_CONSUMED),
        running
          ? v.memoryConsumedMb === null
            ? null
            : Math.round((v.memoryConsumedMb * MIB) / 1e6)
          : 0,
      );
      number(
        ids.feature(FEATURES.UPTIME),
        running ? (v.uptimeSeconds === null ? null : round1(v.uptimeSeconds / 3600)) : 0,
      );
    }
    return states;
  }

  /**
   * Publish what changed, within the minute budget (POST /state admits 300
   * per minute): the room is reserved before awaiting Gladys, so publications
   * at the same time never exceed it together.
   */
  async publishDeviceStates() {
    const fresh = this.statesOf().filter(
      (s) => this.published.get(s.device_feature_external_id) !== valueOf(s),
    );
    if (fresh.length === 0) return;
    const granted = this.budget.reserve(fresh.length);
    if (fresh.length > granted) {
      this.logger.debug(`${fresh.length - granted} state(s) held back (state budget)`);
    }
    const list = fresh.slice(0, granted);
    if (list.length === 0) return;
    // Marked before the await: a publication at the same time sends the others only.
    const before = list.map((s) => [
      s.device_feature_external_id,
      this.published.get(s.device_feature_external_id),
    ]);
    for (const s of list) this.published.set(s.device_feature_external_id, valueOf(s));
    try {
      await this.gladys.publishChangedStates(list);
    } catch (err) {
      for (const [id, value] of before) {
        if (value === undefined) this.published.delete(id);
        else this.published.set(id, value);
      }
      this.logger.warn(`States not published: ${err.message}`);
    }
  }

  /** Forget what was published for a device (Gladys forgot it too). */
  forget(externalId) {
    if (typeof externalId !== 'string') return;
    const prefix = `${externalId}:`;
    for (const id of [...this.published.keys()]) {
      if (id === externalId || id.startsWith(prefix)) this.published.delete(id);
    }
  }

  async publishTransports() {
    const created = createdDevices(this.gladys);
    const present = {
      hosts: new Set(this.inventory.hosts.map((h) => h.id)),
      datastores: new Set(this.inventory.datastores.map((d) => d.id)),
      vms: new Set(this.inventory.vms.map((v) => v.uuid)),
    };
    const entries = [];
    for (const kind of ['hosts', 'datastores', 'vms']) {
      for (const { id, externalId } of created[kind]) {
        entries.push({
          external_id: externalId,
          transport: this.online && present[kind].has(id) ? 'local' : 'unreachable',
        });
      }
    }
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    if (changed.length === 0) return;
    // At most 100 entries per request (the SDK refuses more).
    for (let start = 0; start < changed.length; start += 100) {
      const batch = changed.slice(start, start + 100);
      for (const entry of batch) this.transports.set(entry.external_id, entry.transport);
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) this.transports.delete(entry.external_id);
        this.logger.debug(`Transports not published: ${err.message}`);
      });
    }
  }

  // --- Devices created / deleted in Gladys -------------------------------------------

  async deviceCreated(device) {
    this.forget(device?.external_id);
    this.transports.delete(device?.external_id);
    if (this.online) await this.publishDeviceStates();
    await this.publishTransports();
  }

  async deviceUpdated(device) {
    await this.deviceCreated(device);
  }

  deviceDeleted(device) {
    this.forget(device?.external_id);
    this.transports.delete(device?.external_id);
  }

  // --- VM actions ------------------------------------------------------------------------

  /**
   * A command from Gladys. Only the Start, Shut down and Restart buttons of a
   * VM act; every reading refuses. Resolves when the action is confirmed (or
   * there was nothing to do); rejects with what happened otherwise.
   */
  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseExternalId(this.gladys, feature?.external_id);
    if (!target || target.feature === null) throw new Error(T.errors.unknownDevice);
    if (target.kind !== 'vm' || !Object.hasOwn(VM_ACTIONS, target.feature)) {
      throw new Error(T.errors.readOnly);
    }
    // Strictly the value of a button: never a 0, a true or an empty text.
    if (value !== PRESSED && value !== String(PRESSED)) throw new Error(T.errors.badValue);
    if (!this.config[VM_ACTIONS[target.feature]])
      throw new Error(T.errors.disabled(target.feature));
    if (this.inFlight) throw new Error(T.errors.stillRunning);
    const promise = this.vmAction(target.feature, target.id, received);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) this.inFlight = null;
    }
  }

  /** The checks of an action, on the latest configuration: before the read and right before sending. */
  checkAction(action, uuid, generation, client, ownMark = null) {
    if (!this.config[VM_ACTIONS[action]]) throw new Error(T.errors.disabled(action));
    if (
      generation !== this.generation ||
      client !== this.client ||
      !client ||
      !this.online ||
      this.blocked
    ) {
      throw new Error(T.errors.notConnected);
    }
    if (this.paused()) throw new Error(T.errors.paused(this.pausedUntil - this.now()));
    // An action "in the future" (a clock set back) counts as one now: at most
    // one minute of cooldown, never none.
    const stored = this.store.get('cooldowns', this.cooldownKey(uuid));
    // The mark this very action wrote just before sending is not a cooldown.
    if (ownMark !== null && stored === ownMark) return;
    let last = Number(stored) || 0;
    if (last > this.now()) last = this.now();
    const ago = this.now() - last;
    if (ago < COMMAND.COOLDOWN_MS) throw new Error(T.errors.cooldown(ago));
  }

  /**
   * A failure met by the command that the loop must follow at once (refused
   * credentials, another certificate, HTTP 429 / 5xx): the usual path,
   * persisted. In the background: the ack never waits for Gladys. A missing
   * permission (NoPermission) or a fault of the action never blocks the readings.
   */
  followFailure(err, generation) {
    const pause = err?.code === CODES.HTTP && (err.status === 429 || err.status >= 500);
    const final = isCredentialsRefused(err) || (err?.code === CODES.CERTIFICATE && err.fingerprint);
    if (!pause && !final) return;
    if (pause && !this.online) return;
    /** The failure being followed (the tests wait for it). */
    this.following = this.failed(err, generation).catch((e) =>
      this.logger.warn(`Failure not handled: ${e?.message}`),
    );
  }

  async vmAction(action, uuid, received) {
    const generation = this.generation;
    const client = this.client;
    const sendBy = received + COMMAND.SEND_BY_MS;
    const answerBy = received + COMMAND.ANSWER_BY_MS;
    this.checkAction(action, uuid, generation, client);
    const known = this.inventory.vms.find((v) => v.uuid === uuid);
    if (!known) throw new Error(T.errors.unknownVm);

    // The VM read just before acting, never the one in memory: it must
    // answer, and be the very VM (the same instance UUID at that moref).
    let fresh;
    try {
      fresh = await client.vmCheck(known.moref, received + COMMAND.READ_BY_MS);
    } catch (err) {
      this.followFailure(err, generation);
      if (err?.noSession) throw new Error(T.errors.noSession, { cause: err });
      if (err?.code === CODES.LATE || err?.code === CODES.TIMEOUT) {
        throw new Error(T.errors.tooSlow, { cause: err });
      }
      if (err?.code === CODES.NOT_FOUND) throw new Error(T.errors.vmGone, { cause: err });
      throw new Error(T.errors.unknownState(reasonOf(err).en), { cause: err });
    }
    // An unreadable value is not "another VM": the state is unknown.
    if (!fresh.uuid) throw new Error(T.errors.unknownState('instance UUID not readable'));
    if (fresh.uuid !== uuid || fresh.template === true) throw new Error(T.errors.otherVm);
    // A connection state that cannot be read refuses (unknown), like any value missing.
    if (fresh.connection === null) {
      throw new Error(T.errors.unknownState('connection state not readable'));
    }
    if (fresh.connection !== 'connected') throw new Error(T.errors.vmNotConnected);
    if (fresh.power === null) throw new Error(T.errors.unknownState('power state not readable'));

    let method;
    if (action === FEATURES.START) {
      // Already running: confirmed by the value read, nothing to send.
      if (fresh.power === 'poweredOn') return this.noted(uuid, fresh);
      method = 'PowerOnVM_Task';
    } else if (action === FEATURES.SHUTDOWN) {
      if (fresh.power === 'poweredOff') return this.noted(uuid, fresh);
      if (fresh.power === 'suspended') throw new Error(T.errors.suspended);
      if (!toolsRunning(fresh.tools)) throw new Error(T.errors.toolsNotRunning(action));
      method = 'ShutdownGuest';
    } else {
      if (fresh.power !== 'poweredOn') throw new Error(T.errors.notRunning);
      if (!toolsRunning(fresh.tools)) throw new Error(T.errors.toolsNotRunning(action));
      method = 'RebootGuest';
    }
    // The option may have been turned off during the read: checked again.
    this.checkAction(action, uuid, generation, client);
    if (this.now() > sendBy) throw new Error(T.errors.tooSlow);
    this.logger.info(`VM ${action} requested from Gladys`);
    // The cooldown is written BEFORE the request (a stop of the container
    // between the request and its answer keeps it), and given back when the
    // request certainly did not leave.
    const cooldownKey = this.cooldownKey(uuid);
    const previousCooldown = this.store.get('cooldowns', cooldownKey);
    const mark = String(this.now());
    await this.store.set('cooldowns', cooldownKey, mark);
    const giveBack = async () => {
      if (this.store.get('cooldowns', cooldownKey) === mark) {
        await this.store.set('cooldowns', cooldownKey, previousCooldown);
      }
    };
    try {
      await client.vmAction(method, known.moref, {
        sendBy,
        answerBy,
        // The very last check, right before the request is written (after
        // the TCP and TLS handshakes): the option, the connection, a pause,
        // the cooldown (other than this action's own mark), and the deadline.
        beforeSend: () => {
          this.checkAction(action, uuid, generation, client, mark);
          if (this.now() > sendBy) throw new Error(T.errors.tooSlow);
        },
      });
    } catch (err) {
      if (err?.beforeSend || err?.notSent || err?.noSession || err?.code === CODES.LATE) {
        await giveBack();
      }
      if (err?.beforeSend) throw err;
      const reason = reasonOf(err).en;
      this.logger.warn(`VM ${action}: ${err?.name === 'VsphereError' ? err.message : 'error'}`);
      const cause = { cause: err };
      this.followFailure(err, generation);
      if (err?.noSession) throw new Error(T.errors.noSession, cause);
      if (err?.code === CODES.LATE) throw new Error(T.errors.tooSlow, cause);
      if (err?.notSent) throw new Error(T.errors.notSent(action, reason), cause);
      if (
        err?.status === 429 ||
        [
          CODES.ACCESS,
          CODES.SESSION,
          CODES.NOT_FOUND,
          CODES.RESTRICTED,
          CODES.FAULT,
          CODES.REDIRECT,
        ].includes(err?.code) ||
        (err?.code === CODES.HTTP && err.status < 500)
      ) {
        // The server answered "no": nothing was done (the cooldown stays: a
        // scene in a loop does not hammer a refusing server).
        throw new Error(T.errors.refused(action, reason), cause);
      }
      // A 5xx, a silence, a broken answer after the request was written: it
      // may have reached the server.
      await this.sent(uuid, generation);
      throw new Error(T.errors.sentUnconfirmed(action, reason), cause);
    }
    await this.sent(uuid, generation);
    if (action !== FEATURES.START) throw new Error(T.errors.guestAsked(action));
    // A start is confirmed only by the power state read again, before the ack deadline.
    const confirmed = await this.confirmStart(client, known.moref, uuid, answerBy);
    if (!confirmed) throw new Error(T.errors.startUnconfirmed);
    return this.noted(uuid, confirmed);
  }

  /** The power state read again until `answerBy`: the fresh state once running, else null. */
  async confirmStart(client, moref, uuid, answerBy) {
    for (;;) {
      if (this.now() >= answerBy) return null;
      try {
        const state = await client.vmCheck(moref, answerBy);
        if (state.uuid === uuid && state.power === 'poweredOn') return state;
      } catch {
        return null;
      }
      const left = answerBy - this.now();
      if (left <= COMMAND.CONFIRM_STEP_MS) return null;
      // A short real pause between two readings of the power state (bounded by
      // `answerBy` above, never part of the loop's timers).
      await delay(COMMAND.CONFIRM_STEP_MS);
    }
  }

  /** An action sent (its cooldown already in /data): one reading of the VM later. */
  async sent(uuid, generation) {
    const epoch = this.epoch;
    this.schedule(COMMAND.FOLLOW_UP_MS, () => this.followUp(uuid, generation, epoch));
  }

  /** A state read for a VM (fresh, or confirmed): kept, published in the background. Resolves nothing. */
  noted(uuid, state) {
    const vm = this.inventory.vms.find((v) => v.uuid === uuid);
    if (vm && state.power) {
      vm.power = state.power;
      if (state.tools) vm.tools = state.tools;
      // The ack never waits for Gladys.
      this.publishDeviceStates().catch(() => {});
    }
  }

  /** The VM read once after an action, for its new state (never during a pause or a reading). */
  async followUp(uuid, generation, epoch) {
    if (!this.current(generation, epoch) || this.paused() || this.reading || !this.online) return;
    const vm = this.inventory.vms.find((v) => v.uuid === uuid);
    const client = this.client;
    if (!vm || !client) return;
    try {
      const state = await client.vmCheck(vm.moref, this.now() + COMMAND.ANSWER_BY_MS);
      if (client !== this.client || state.uuid !== uuid) return;
      this.noted(uuid, state);
    } catch {
      // The next reading says it.
    }
  }

  // --- Configuration button ------------------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /**
   * Reconnects, then reports, within 25 s. Like a reconnection to Gladys, it
   * never reads faster than the interval: it answers from the last reading or
   * the status of the last failure until the next attempt. Refused
   * credentials are not tried again (only saving the configuration does), nor
   * is a pause shortened.
   */
  async testConnection() {
    await this.within(this.start(this.rawConfig), TEST_BUDGET_MS, T.errors.testTooLong);
    if (!this.online) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    return T.test.ok(this.okMessage());
  }
}
