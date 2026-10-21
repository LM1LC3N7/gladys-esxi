// -----------------------------------------------------------------------------
// Gladys devices (pure).
//
//   host       `ext:<selector>:host:<moref>`
//              connected, maintenance mode, CPU and memory load, memory used
//              and total, uptime, health, VMs running, version
//   datastore  `ext:<selector>:datastore:<moref>`
//              accessible, usage, free space, capacity
//   vm         `ext:<selector>:vm:<instance uuid>`
//              running, power state, VMware Tools running, CPU load, memory
//              consumed, uptime, health; Start, Shut down, Restart (buttons,
//              refused unless allowed)
//
// Every reading is read only. The actions are `button`/`push` features, never
// a switch nor a binary: a "turn everything off" of a voice assistant, MCP or
// a `switch` scene action must not reach them. There is no host action at
// all (no shutdown, reboot, standby nor maintenance mode).
//
// A device published again never loses a feature: the core would mark it
// `structure_changed`, and "Update" would drop the history of the missing
// one. The features of the device created in Gladys (`gladys.devices`, kept
// up to date by the SDK) are added back when the blueprint lacks them.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DATASTORE_TYPE, FEATURES, HOST_TYPE, VM_TYPE } from './constants.js';
import { INSTANCE_UUID, MOREF_ID } from './vsphere/parse.js';

export const hostIds = (gladys, id) => gladys.externalIds(HOST_TYPE, id);
export const datastoreIds = (gladys, id) => gladys.externalIds(DATASTORE_TYPE, id);
export const vmIds = (gladys, uuid) => gladys.externalIds(VM_TYPE, uuid);

const reading = (extra) => ({ read_only: true, has_feedback: false, keep_history: true, ...extra });
// Read only, never a switch: the core hands every switch to the voice
// assistants, MCP and the switch scene actions.
const binary = (name) => [
  name,
  reading({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 }),
];
// No core category lists a percent for a processor, a memory or a disk load:
// `unknown`/`unknown` without a unit, the unit in the name (TODO.md).
const percent = (name) => [
  name,
  reading({ category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max: 100 }),
];
const text = (name) => [
  name,
  reading({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false }),
];
const size = (name, unit, max) => [
  name,
  reading({ category: C.DATA, type: T.DATA.SIZE, unit, min: 0, max }),
];
const uptime = () => [
  'Uptime',
  reading({
    category: C.DURATION,
    type: T.DURATION.DECIMAL,
    unit: U.HOURS,
    min: 0,
    max: 10_000_000,
  }),
];
/** A push button (refused unless allowed in the configuration). */
const button = (name) => [
  name,
  {
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
  },
];

export const HOST_FEATURES = [
  [FEATURES.CONNECTED, ...binary('Connected')],
  [FEATURES.MAINTENANCE, ...binary('Maintenance mode')],
  [FEATURES.CPU_USAGE, ...percent('CPU (%)')],
  [FEATURES.MEMORY_USAGE, ...percent('Memory (%)')],
  [FEATURES.MEMORY_USED, ...size('Memory used', U.GIGABYTE, 1_000_000)],
  [FEATURES.MEMORY_TOTAL, ...size('Memory total', U.GIGABYTE, 1_000_000)],
  [FEATURES.UPTIME, ...uptime()],
  [FEATURES.HEALTH, ...text('Health')],
  [
    FEATURES.VMS_RUNNING,
    'VMs running',
    reading({ category: C.COUNTER_SENSOR, type: T.SENSOR.INTEGER, min: 0, max: 100_000 }),
  ],
  [FEATURES.VERSION, ...text('Version')],
];

export const DATASTORE_FEATURES = [
  [FEATURES.ACCESSIBLE, ...binary('Accessible')],
  [FEATURES.USAGE, ...percent('Used (%)')],
  [FEATURES.FREE, ...size('Free space', U.GIGABYTE, 1_000_000_000)],
  [FEATURES.CAPACITY, ...size('Capacity', U.GIGABYTE, 1_000_000_000)],
];

export const VM_FEATURES = [
  [FEATURES.RUNNING, ...binary('Running')],
  [FEATURES.POWER_STATE, ...text('Power state')],
  [FEATURES.TOOLS_RUNNING, ...binary('VMware Tools running')],
  [FEATURES.CPU_USAGE, ...percent('CPU (%)')],
  [FEATURES.MEMORY_CONSUMED, ...size('Memory consumed', U.MEGABYTE, 100_000_000)],
  [FEATURES.UPTIME, ...uptime()],
  [FEATURES.HEALTH, ...text('Health')],
  [FEATURES.START, ...button('Start')],
  [FEATURES.SHUTDOWN, ...button('Shut down (guest)')],
  [FEATURES.RESTART, ...button('Restart (guest)')],
];

/** The features of the created device the blueprint lacks, appended (never fewer). */
export function withCreatedFeatures(gladys, device, devices = gladys.devices) {
  const created = (devices ?? []).find((d) => d?.external_id === device.external_id);
  if (!created) return device;
  const known = new Set(device.features.map((f) => f.external_id));
  const extra = (created.features ?? []).filter(
    (f) => f && typeof f.external_id === 'string' && !known.has(f.external_id),
  );
  if (extra.length === 0) return device;
  return { ...device, features: [...device.features, ...extra] };
}

const build = (gladys, ids, { name, model }, list) =>
  withCreatedFeatures(gladys, {
    name,
    external_id: ids.device,
    model,
    should_poll: false,
    features: list.map(([key, featureName, definition]) => ({
      name: featureName,
      external_id: ids.feature(key),
      ...definition,
    })),
  });

/** @param {{ id: string, name?: string|null, vendor?: string|null, model?: string|null }} host */
export function buildHostDevice(gladys, host) {
  const hardware = [host.vendor, host.model].filter(Boolean).join(' ');
  return build(
    gladys,
    hostIds(gladys, host.id),
    { name: host.name || `ESXi ${host.id}`, model: (hardware || 'VMware ESXi host').slice(0, 80) },
    HOST_FEATURES,
  );
}

/** @param {{ id: string, name?: string|null, type?: string|null }} datastore */
export function buildDatastoreDevice(gladys, datastore) {
  return build(
    gladys,
    datastoreIds(gladys, datastore.id),
    {
      name: `Datastore ${datastore.name || datastore.id}`.slice(0, 80),
      model: datastore.type ? `Datastore ${datastore.type}` : 'Datastore',
    },
    DATASTORE_FEATURES,
  );
}

/** @param {{ uuid: string, name?: string|null }} vm */
export function buildVmDevice(gladys, vm) {
  return build(
    gladys,
    vmIds(gladys, vm.uuid),
    { name: vm.name || `VM ${vm.uuid.slice(0, 8)}`, model: 'Virtual machine' },
    VM_FEATURES,
  );
}

/**
 * What a device or feature external id of this integration designates:
 * { kind: 'host' | 'datastore' | 'vm', id, feature } or null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) return null;
  for (const [kind, type, pattern] of [
    ['host', HOST_TYPE, MOREF_ID],
    ['datastore', DATASTORE_TYPE, MOREF_ID],
    ['vm', VM_TYPE, INSTANCE_UUID],
  ]) {
    const prefix = gladys.externalId(`${type}:`);
    if (!externalId.startsWith(prefix)) continue;
    const [id, feature, ...rest] = externalId.slice(prefix.length).split(':');
    if (rest.length > 0 || !pattern.test(id ?? '')) return null;
    if (feature !== undefined && !/^[a-z_]{1,40}$/.test(feature)) return null;
    return { kind, id, feature: feature ?? null };
  }
  return null;
}

/** The created devices of this integration: { hosts, datastores, vms }: [{ id, externalId }]. */
export function createdDevices(gladys, devices = gladys.devices) {
  const out = { hosts: [], datastores: [], vms: [] };
  for (const device of devices ?? []) {
    const parsed = parseExternalId(gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) continue;
    out[`${parsed.kind}s`].push({ id: parsed.id, externalId: device.external_id });
  }
  return out;
}
