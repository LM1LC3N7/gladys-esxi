// -----------------------------------------------------------------------------
// The properties read from vSphere and their conversion into plain objects
// (pure). Property paths are those of the vSphere API reference (and of
// pyVmomi's type info); a property the server does not have comes back in
// `missingSet` and is read as unknown (null), never as 0.
//
// What leaves this file: names (cut, without control characters), numbers
// within bounds, the power and connection states. The guest host name, the
// IP addresses, the MAC addresses, the BIOS UUIDs and the annotations are
// never asked for.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

export const HOST_PROPS = Object.freeze([
  'name',
  'summary.hardware.vendor',
  'summary.hardware.model',
  'summary.hardware.cpuMhz',
  'summary.hardware.numCpuCores',
  'summary.hardware.memorySize',
  'summary.quickStats.overallCpuUsage',
  'summary.quickStats.overallMemoryUsage',
  'summary.quickStats.uptime',
  'summary.runtime.connectionState',
  'summary.runtime.powerState',
  'summary.runtime.inMaintenanceMode',
  'summary.overallStatus',
  'summary.config.product.fullName',
]);

export const DATASTORE_PROPS = Object.freeze([
  'summary.name',
  'summary.type',
  'summary.capacity',
  'summary.freeSpace',
  'summary.accessible',
]);

export const VM_PROPS = Object.freeze([
  'name',
  'config.instanceUuid',
  'config.template',
  'runtime.powerState',
  'runtime.connectionState',
  'runtime.host',
  'summary.config.numCpu',
  'summary.config.memorySizeMB',
  'summary.quickStats.overallCpuUsage',
  'summary.quickStats.hostMemoryUsage',
  'summary.quickStats.uptimeSeconds',
  'summary.overallStatus',
  'guest.toolsRunningStatus',
]);

/** What a VM action needs, read again just before it. */
export const VM_CHECK_PROPS = Object.freeze([
  'config.instanceUuid',
  'config.template',
  'runtime.powerState',
  'runtime.connectionState',
  'guest.toolsRunningStatus',
]);

/** The ids used in external ids: lowercase, digits, dashes (`ha-host`, `host-12`, a VMFS UUID). */
export const MOREF_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** A moref value sent back in a request (never in an external id). */
export const MOREF_VALUE = /^[A-Za-z0-9._-]{1,80}$/;
export const INSTANCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const POWER_STATES = new Set(['poweredOn', 'poweredOff', 'suspended']);
const HOST_POWER = new Set(['poweredOn', 'poweredOff', 'standBy', 'unknown']);
const HOST_CONNECTION = new Set(['connected', 'disconnected', 'notResponding']);
const VM_CONNECTION = new Set(['connected', 'disconnected', 'orphaned', 'inaccessible', 'invalid']);
const STATUS = new Set(['gray', 'green', 'yellow', 'red']);
const TOOLS = new Set(['guestToolsNotRunning', 'guestToolsRunning', 'guestToolsExecutingScripts']);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/** A name for Gladys: no control character, trimmed, cut; null when empty. */
export function cleanText(value, max = LIMITS.TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

/** A number within [min, max], or null (never NaN, never a text). */
const number = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
const bool = (value) => (typeof value === 'boolean' ? value : null);
const oneOf = (value, set) => (typeof value === 'string' && set.has(value) ? value : null);

export function parseHost(object) {
  const id = object.id;
  if (!MOREF_ID.test(id)) return null;
  const p = object.props;
  return {
    id,
    name: cleanText(p.get('name')),
    vendor: cleanText(p.get('summary.hardware.vendor')),
    model: cleanText(p.get('summary.hardware.model')),
    cpuMhz: number(p.get('summary.hardware.cpuMhz'), 1, 100_000),
    cores: number(p.get('summary.hardware.numCpuCores'), 1, 4096),
    memoryBytes: number(p.get('summary.hardware.memorySize'), 1, 2 ** 53),
    cpuUsedMhz: number(p.get('summary.quickStats.overallCpuUsage'), 0, 1e9),
    memoryUsedMb: number(p.get('summary.quickStats.overallMemoryUsage'), 0, 1e9),
    uptimeSeconds: number(p.get('summary.quickStats.uptime'), 0, 1e10),
    connection: oneOf(p.get('summary.runtime.connectionState'), HOST_CONNECTION),
    power: oneOf(p.get('summary.runtime.powerState'), HOST_POWER),
    maintenance: bool(p.get('summary.runtime.inMaintenanceMode')),
    status: oneOf(p.get('summary.overallStatus'), STATUS),
    product: cleanText(p.get('summary.config.product.fullName')),
  };
}

export function parseDatastore(object) {
  const id = object.id;
  if (!MOREF_ID.test(id)) return null;
  const p = object.props;
  return {
    id,
    name: cleanText(p.get('summary.name')),
    type: cleanText(p.get('summary.type'), 16),
    capacity: number(p.get('summary.capacity'), 0, 2 ** 53),
    free: number(p.get('summary.freeSpace'), 0, 2 ** 53),
    accessible: bool(p.get('summary.accessible')),
  };
}

/** A VM, or null (a template, no readable instance UUID, an unusable moref). */
export function parseVm(object) {
  if (!MOREF_VALUE.test(object.id)) return null;
  const p = object.props;
  const uuid = typeof p.get('config.instanceUuid') === 'string' ? p.get('config.instanceUuid') : '';
  const instanceUuid = uuid.toLowerCase();
  if (!INSTANCE_UUID.test(instanceUuid)) return null;
  if (p.get('config.template') === true) return null;
  const host = p.get('runtime.host');
  return {
    moref: object.id,
    uuid: instanceUuid,
    name: cleanText(p.get('name')),
    power: oneOf(p.get('runtime.powerState'), POWER_STATES),
    connection: oneOf(p.get('runtime.connectionState'), VM_CONNECTION),
    host: typeof host === 'string' && MOREF_ID.test(host) ? host : null,
    cpus: number(p.get('summary.config.numCpu'), 1, 1024),
    memoryMb: number(p.get('summary.config.memorySizeMB'), 1, 1e8),
    cpuUsedMhz: number(p.get('summary.quickStats.overallCpuUsage'), 0, 1e9),
    memoryConsumedMb: number(p.get('summary.quickStats.hostMemoryUsage'), 0, 1e9),
    uptimeSeconds: number(p.get('summary.quickStats.uptimeSeconds'), 0, 1e10),
    status: oneOf(p.get('summary.overallStatus'), STATUS),
    tools: oneOf(p.get('guest.toolsRunningStatus'), TOOLS),
  };
}

/**
 * The state of a VM read again before an action: { uuid, template, power,
 * connection, tools } (null for what could not be read).
 */
export function parseVmCheck(object) {
  const p = object.props;
  const uuid = p.get('config.instanceUuid');
  const instanceUuid = typeof uuid === 'string' ? uuid.toLowerCase() : null;
  return {
    uuid: instanceUuid && INSTANCE_UUID.test(instanceUuid) ? instanceUuid : null,
    template: bool(p.get('config.template')),
    power: oneOf(p.get('runtime.powerState'), POWER_STATES),
    connection: oneOf(p.get('runtime.connectionState'), VM_CONNECTION),
    tools: oneOf(p.get('guest.toolsRunningStatus'), TOOLS),
  };
}

/** The `about` of the ServiceContent: { apiType, version, fullName }. */
export function parseAbout(fields) {
  const apiType = ['HostAgent', 'VirtualCenter'].includes(fields.apiType) ? fields.apiType : null;
  return {
    apiType,
    version: cleanText(fields.version, 16),
    fullName: cleanText(fields.fullName),
  };
}

/**
 * Hosts, datastores and VMs from the objects of a reading, each list bounded;
 * a VM met twice (a copy with the same instance UUID) is kept once.
 */
export function parseInventory(objects) {
  const hosts = [];
  const datastores = [];
  const vms = [];
  const uuids = new Set();
  let skipped = 0;
  for (const object of objects) {
    if (object.type === 'HostSystem') {
      const host = hosts.length < LIMITS.HOSTS ? parseHost(object) : null;
      if (host) hosts.push(host);
      else skipped += 1;
    } else if (object.type === 'Datastore') {
      const ds = datastores.length < LIMITS.DATASTORES ? parseDatastore(object) : null;
      if (ds) datastores.push(ds);
      else skipped += 1;
    } else if (object.type === 'VirtualMachine') {
      const vm = vms.length < LIMITS.VMS ? parseVm(object) : null;
      if (vm && !uuids.has(vm.uuid)) {
        uuids.add(vm.uuid);
        vms.push(vm);
      } else {
        skipped += 1;
      }
    }
  }
  return { hosts, datastores, vms, skipped };
}
