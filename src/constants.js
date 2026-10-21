// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys and the external id shapes are
// stored in user scenes and devices: never rename them (test/manifest.test.js
// ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

/**
 * Device external ids:
 *   `ext:<selector>:host:<moref>`        one per ESXi host (`ha-host` on a
 *                                        standalone ESXi, `host-12` on vCenter)
 *   `ext:<selector>:datastore:<moref>`   one per datastore
 *   `ext:<selector>:vm:<instance uuid>`  one per virtual machine, by the
 *                                        instance UUID vSphere gives it (stable
 *                                        across a rename, a vMotion, a reboot)
 */
export const HOST_TYPE = 'host';
export const DATASTORE_TYPE = 'datastore';
export const VM_TYPE = 'vm';

export const FEATURES = Object.freeze({
  // Host
  CONNECTED: 'connected',
  MAINTENANCE: 'maintenance',
  CPU_USAGE: 'cpu_usage',
  MEMORY_USAGE: 'memory_usage',
  MEMORY_USED: 'memory_used',
  MEMORY_TOTAL: 'memory_total',
  UPTIME: 'uptime',
  HEALTH: 'health',
  VMS_RUNNING: 'vms_running',
  VERSION: 'version',
  // Datastore
  ACCESSIBLE: 'accessible',
  USAGE: 'usage',
  FREE: 'free',
  CAPACITY: 'capacity',
  // Virtual machine (CPU_USAGE, UPTIME, HEALTH shared)
  RUNNING: 'running',
  POWER_STATE: 'power_state',
  TOOLS_RUNNING: 'tools_running',
  MEMORY_CONSUMED: 'memory_consumed',
  START: 'start',
  SHUTDOWN: 'shutdown',
  RESTART: 'restart',
});

/** The VM actions: button feature -> configuration option. */
export const VM_ACTIONS = Object.freeze({
  [FEATURES.START]: 'allowStart',
  [FEATURES.SHUTDOWN]: 'allowShutdown',
  [FEATURES.RESTART]: 'allowRestart',
});

export const DEFAULT_PORT = 443;

/** Seconds between two readings. */
export const POLL_INTERVALS = Object.freeze(['60', '120', '300', '600']);

export const LIMITS = Object.freeze({
  HOSTS: 32,
  DATASTORES: 64,
  VMS: 200,
  /** Objects asked per page of RetrievePropertiesEx, and the pages read at most. */
  PAGE_OBJECTS: 100,
  PAGES: 6,
  /** POST /state admits 300 states per minute per integration: we keep under 250. */
  STATES_PER_MINUTE: 250,
  /** A text published to Gladys (a name, a version) is cut to this length. */
  TEXT_LENGTH: 64,
  /** VM action cooldowns kept in /data (the oldest are dropped). */
  COOLDOWNS: 200,
});

export const TIMEOUTS = Object.freeze({
  /** One SOAP request. */
  API: 15_000,
  /** The logout at a stop (best effort). */
  LOGOUT: 3_000,
});

export const INTERVALS = Object.freeze({
  /** A failure is retried after max(this, the poll interval), doubling. */
  RETRY_MIN_MS: 60_000,
  RETRY_MAX_MS: 30 * 60_000,
  /** HTTP 429 / 5xx: pause of every request, within these bounds (Retry-After if given). */
  BUSY_MIN_MS: 60_000,
  BUSY_MAX_MS: 6 * 3600_000,
  /** The time of the last attempt is written to /data at most this often. */
  ATTEMPT_WRITE_MS: 60_000,
});

/** The VM actions: deadlines counted from the arrival of the command (Gladys acks within 5 s). */
export const COMMAND = Object.freeze({
  /** The fresh reading of the VM must end by then. */
  READ_BY_MS: 2_000,
  /** The action is refused unsent after this. */
  SEND_BY_MS: 3_500,
  /** The answer (and the confirmation of a start) is awaited until this. */
  ANSWER_BY_MS: 4_500,
  /** Between two readings of the power state while confirming a start. */
  CONFIRM_STEP_MS: 400,
  /** No second action on the same VM before this delay (a scene in a loop): kept in /data. */
  COOLDOWN_MS: 60_000,
  /** One reading of the VM this long after an action, for its new state. */
  FOLLOW_UP_MS: 20_000,
});

/** The only value a `button`/`push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** Size cap of a SOAP answer. */
export const MAX_BYTES = 4 * 1024 * 1024;

/** The persistent store (refusals, pins, pauses, attempts, cooldowns: see src/store.js). */
export const STORE_FILE = 'esxi.json';

/** The vSphere Web Services (SOAP) endpoint and the API version asked for. */
export const SOAP_PATH = '/sdk';
export const SOAP_ACTION = 'urn:vim25/6.5';
