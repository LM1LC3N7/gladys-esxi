// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake vSphere server,
// through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EsxiApp } from '../src/app.js';
import { ACTIONS, COMMAND } from '../src/constants.js';
import { buildDatastoreDevice, buildHostDevice, buildVmDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import {
  PASSWORD,
  SECRETS,
  VM2_UUID,
  VM_UUID,
  createFakeVsphere,
  faultXml,
} from './helpers/fakeVsphere.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-21T08:00:00Z');
const SELECTOR = 'esxi';
const ids = createFakeGladys({ selector: SELECTOR });
const HOST = `ext:${SELECTOR}:host:ha-host`;
const DATASTORE = `ext:${SELECTOR}:datastore:5f1a2b3c-4d5e6f70-1a2b-001122334455`;
const VM = `ext:${SELECTOR}:vm:${VM_UUID}`;
const VM2 = `ext:${SELECTOR}:vm:${VM2_UUID}`;
const BASE_CONFIG = { host: '192.168.1.10', username: 'gladys', password: PASSWORD };
const ALLOW_ALL = { allow_vm_start: true, allow_vm_shutdown: true, allow_vm_restart: true };

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

function createdDevices() {
  return [
    buildHostDevice(ids, { id: 'ha-host' }),
    buildDatastoreDevice(ids, { id: '5f1a2b3c-4d5e6f70-1a2b-001122334455' }),
    buildVmDevice(ids, { uuid: VM_UUID }),
    buildVmDevice(ids, { uuid: VM2_UUID }),
  ];
}

async function setup({
  config = {},
  created = true,
  server,
  dataDir,
  clock = { now: T0 },
  connect = true,
} = {}) {
  server ??= createFakeVsphere({ clock });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices: created ? createdDevices() : [],
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  dataDir ??= mkdtempSync(join(tmpdir(), 'esxi-app-'));
  const app = new EsxiApp({
    gladys,
    logger,
    request: server.request,
    dataDir,
    now: () => clock.now,
    timers,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  if (connect) await gladys.connect();
  return { gladys, server, timers, clock, logs, app, dataDir };
}

const poll = (timers, ms = 60_000) => timers.run((delay) => delay === ms);
const last = (gladys, id) => gladys.fake.lastState(id);
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
async function reconnect(gladys, app) {
  gladys.emit('connected');
  await settle();
  await app.queue;
}
const press = (gladys, uuid, action) =>
  gladys.fake.setValue(
    buildVmDevice(ids, { uuid }),
    { external_id: `ext:${SELECTOR}:vm:${uuid}:${action}` },
    1,
  );
const storeOf = (dataDir) => JSON.parse(readFileSync(join(dataDir, 'esxi.json'), 'utf8'));

/** Nothing secret anywhere: logs, Gladys, /data; no VM name in the logs. */
function assertClean({ logs, gladys, dataDir }) {
  const files = readdirSync(dataDir).map((f) => readFileSync(join(dataDir, f), 'utf8'));
  const places = {
    logs: logs.join('\n'),
    states: JSON.stringify(gladys.fake.states),
    discovery: JSON.stringify(gladys.fake.discoveredDevices),
    statuses: JSON.stringify(gladys.fake.connectionStatuses),
    data: files.join('\n'),
  };
  for (const [place, text] of Object.entries(places)) {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${place} holds ${secret}`);
  }
  for (const name of ['home-assistant', 'nas', 'esxi01.lan']) {
    assert.ok(!places.logs.includes(name), `the logs hold ${name}`);
  }
}

test('start: status, Discovery, states, badges; one request per reading every 60 s', async () => {
  const ctx = await setup();
  const { gladys, server, timers } = ctx;
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'VMware ESXi 8.0.3 build-24022510 answers: 1 host, 1 of 2 VMs running.',
      fr: 'VMware ESXi 8.0.3 build-24022510 répond : 1 hôte, 1 VM en marche sur 2.',
    },
  });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name, d.model]),
    [
      [HOST, 'esxi01.lan', 'Dell Inc. OptiPlex 7070'],
      [DATASTORE, 'Datastore datastore1', 'Datastore VMFS'],
      [VM, 'home-assistant', 'Virtual machine'],
      [VM2, 'nas', 'Virtual machine'],
    ],
  );
  assert.equal(last(gladys, `${HOST}:connected`), 1);
  assert.equal(last(gladys, `${HOST}:maintenance`), 0);
  assert.equal(last(gladys, `${HOST}:cpu_usage`), 25);
  assert.equal(last(gladys, `${HOST}:memory_usage`), 50);
  assert.equal(last(gladys, `${HOST}:memory_used`), 17.2);
  assert.equal(last(gladys, `${HOST}:memory_total`), 34.4);
  assert.equal(last(gladys, `${HOST}:uptime`), 2);
  assert.equal(last(gladys, `${HOST}:health`), 'green');
  assert.equal(last(gladys, `${HOST}:vms_running`), 1);
  assert.equal(last(gladys, `${HOST}:version`), 'VMware ESXi 8.0.3 build-24022510');
  assert.equal(last(gladys, `${DATASTORE}:accessible`), 1);
  assert.equal(last(gladys, `${DATASTORE}:usage`), 75);
  assert.equal(last(gladys, `${DATASTORE}:free`), 125);
  assert.equal(last(gladys, `${DATASTORE}:capacity`), 500);
  assert.equal(last(gladys, `${VM}:running`), 1);
  assert.equal(last(gladys, `${VM}:power_state`), 'poweredOn');
  assert.equal(last(gladys, `${VM}:tools_running`), 1);
  assert.equal(last(gladys, `${VM}:cpu_usage`), 25);
  assert.equal(last(gladys, `${VM}:memory_consumed`), 2147);
  assert.equal(last(gladys, `${VM}:uptime`), 1);
  assert.equal(last(gladys, `${VM2}:running`), 0);
  assert.equal(last(gladys, `${VM2}:power_state`), 'poweredOff');
  assert.equal(last(gladys, `${VM2}:cpu_usage`), 0);
  assert.equal(gladys.fake.transports.length, 4);
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'local'));
  assert.deepEqual(timers.delays(), [60_000]);
  assert.deepEqual(server.methods(), ['RetrieveServiceContent', 'Login', 'RetrievePropertiesEx']);
  assert.match(server.requests[0].headers['user-agent'], /^gladys-esxi\/\d+\.\d+\.\d+$/);

  // The next reading: one request, the same session.
  ctx.clock.now += 60_000;
  server.vms[1].powerState = 'poweredOn';
  await poll(timers);
  assert.deepEqual(server.methods().slice(3), ['RetrievePropertiesEx']);
  assert.equal(last(gladys, `${VM2}:running`), 1);
  assert.equal(last(gladys, `${HOST}:vms_running`), 2);
  assertClean(ctx);
});

test('vCenter: the same calls with the morefs of its service content', async () => {
  const clock = { now: T0 };
  const server = createFakeVsphere({ clock, apiType: 'VirtualCenter' });
  server.hosts = [{ ...server.hosts[0], moref: 'host-12' }];
  server.vms[0].host = 'host-12';
  const { gladys } = await setup({ server, clock, created: false });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(
    gladys.fake.discoveredDevices.some((d) => d.external_id === `ext:${SELECTOR}:host:host-12`),
  );
  const login = server.logins()[0];
  assert.match(login.body, /<_this type="SessionManager">SessionManager<\/_this>/);
});

test('credentials refused: stopped, remembered as an HMAC in /data, tried again only once saved', async () => {
  const clock = { now: T0 };
  const server = createFakeVsphere({ clock });
  server.password = 'another';
  const ctx = await setup({ server, clock });
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.en,
    /refused the user name or the password/,
  );
  assert.deepEqual(ctx.timers.delays(), [], 'no retry');
  assert.equal(server.logins().length, 1);
  const stored = storeOf(ctx.dataDir);
  assert.match(Object.values(stored.refusals)[0], /^[0-9a-f]{64}$/);
  assertClean(ctx);

  // A restart of the container: nothing sent.
  await ctx.app.stop();
  const again = await setup({ server, clock, dataDir: ctx.dataDir });
  assert.equal(server.logins().length, 1);
  assert.match(again.gladys.fake.connectionStatus.message.en, /refused/);

  // The configuration saved (the right password now on the server): tried again, the refusal erased.
  server.password = PASSWORD;
  // Saved with the same values: never faster than the interval after the refusal.
  clock.now += 5_000;
  await again.app.start({ ...BASE_CONFIG }, { force: true });
  assert.equal(server.logins().length, 1);
  clock.now += 55_000;
  await again.app.start({ ...BASE_CONFIG }, { force: true });
  assert.equal(server.logins().length, 2);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(storeOf(ctx.dataDir).refusals, {});
});

const IMPOSTOR = 'EE:'.repeat(31) + 'EE';
const THIRD = '33:'.repeat(31) + '33';

/** An impostor's certificate at the address: the loop stops on it. */
async function impostor() {
  const clock = { now: T0 };
  const ctx = await setup({ clock });
  ctx.server.fingerprint = IMPOSTOR;
  ctx.server.dropSessions();
  clock.now += 60_000;
  ctx.before = ctx.server.requests.length;
  await poll(ctx.timers);
  return ctx;
}

test('another certificate: nothing sent, stopped, its fingerprint kept in /data and shown', async () => {
  const ctx = await impostor();
  const { server, timers, gladys, app } = ctx;
  assert.equal(server.requests.length, ctx.before, 'nothing written to the impostor');
  assert.match(gladys.fake.connectionStatus.message.en, /certificate/);
  assert.ok(gladys.fake.connectionStatus.message.en.includes(IMPOSTOR), 'fingerprint shown (en)');
  assert.ok(gladys.fake.connectionStatus.message.fr.includes(IMPOSTOR), 'fingerprint shown (fr)');
  assert.deepEqual(timers.delays(), []);
  assert.equal(storeOf(ctx.dataDir).meta['certChanged|192.168.1.10:443'], IMPOSTOR);
  await reconnect(gladys, app);
  assert.equal(server.requests.length, ctx.before);
});

test('B1: saving another option never trusts a changed certificate (no TOFU again, no Login)', async () => {
  const ctx = await impostor();
  const { server, timers, gladys, app, clock } = ctx;
  const logins = server.logins().length;
  clock.now += 3600_000;
  await app.start({ ...BASE_CONFIG, allow_vm_start: true }, { force: true });
  clock.now += 3600_000;
  await timers.run();
  await settle();
  assert.equal(server.logins().length, logins, 'no Login to the impostor');
  assert.equal(server.requests.length, ctx.before, 'nothing at all');
  assert.ok(gladys.fake.connectionStatus.message.en.includes(IMPOSTOR));
  assert.notEqual(storeOf(ctx.dataDir).pins['192.168.1.10:443'], IMPOSTOR, 'never re-learned');
});

test('B1: the fingerprint typed lifts the stop, and only on that certificate; a third one is refused', async () => {
  const ctx = await impostor();
  const { server, gladys, app, clock } = ctx;
  clock.now += 60_000;
  await app.start({ ...BASE_CONFIG, certificate_fingerprint: IMPOSTOR }, { force: true });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const logins = server.logins().slice(-1);
  assert.equal(logins.length, 1);
  assert.equal(logins[0].pin, IMPOSTOR);
  assert.equal(storeOf(ctx.dataDir).meta['certChanged|192.168.1.10:443'], undefined);
  // A third certificate: refused before anything, the fingerprint typed is shown as not met.
  server.fingerprint = THIRD;
  server.dropSessions();
  const count = server.requests.length;
  clock.now += 60_000;
  await poll(ctx.timers);
  assert.equal(server.requests.length, count);
  assert.ok(gladys.fake.connectionStatus.message.en.includes(THIRD));
  assert.match(gladys.fake.connectionStatus.message.en, /whose fingerprint you typed/);
});

test('B1: "Trust the new certificate" pins exactly the one shown; nothing to trust otherwise', async () => {
  const fresh = await setup();
  const nothing = await fresh.gladys.fake.action(ACTIONS.TRUST);
  assert.match(nothing.data.message.en, /No changed certificate/);
  const ctx = await impostor();
  const { server, gladys } = ctx;
  const ack = await gladys.fake.action(ACTIONS.TRUST);
  assert.equal(ack.success, true);
  assert.ok(ack.data.message.en.includes(IMPOSTOR));
  assert.equal(gladys.fake.connectionStatus.connected, true, 'read at once');
  assert.equal(server.logins().at(-1).pin, IMPOSTOR);
  assert.equal(storeOf(ctx.dataDir).pins['192.168.1.10:443'], IMPOSTOR);
});

test('a typed fingerprint is the only one accepted, from the first request', async () => {
  const clock = { now: T0 };
  const server = createFakeVsphere({ clock });
  const ctx = await setup({
    server,
    clock,
    config: { certificate_fingerprint: 'cc'.repeat(32) },
  });
  assert.equal(server.requests.length, 0);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /certificate/);
  const ok = await setup({
    clock,
    config: { certificate_fingerprint: server.fingerprint.replaceAll(':', '').toLowerCase() },
  });
  assert.equal(ok.gladys.fake.connectionStatus.connected, true);
  assert.ok(ok.server.requests.every((r) => r.pin === server.fingerprint));
});

test('HTTP 503: every request paused, the pause kept in /data across a restart; a SOAP fault is not a pause', async () => {
  const clock = { now: T0 };
  const ctx = await setup({ clock });
  const { server, timers } = ctx;
  server.failures.push({ status: 503, headers: { 'retry-after': '600' }, body: 'busy' });
  clock.now += 60_000;
  await poll(timers);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /HTTP 503/);
  assert.deepEqual(timers.delays(), [600_000]);
  const until = Number(storeOf(ctx.dataDir).meta['pausedUntil|192.168.1.10:443']);
  assert.equal(until, clock.now + 600_000);
  await ctx.app.stop();
  const count = server.requests.length;
  const again = await setup({ server, clock, dataDir: ctx.dataDir });
  assert.equal(server.requests.length, count, 'nothing during the pause');
  assert.match(again.gladys.fake.connectionStatus.message.en, /pause goes on/);

  // A SOAP fault (HTTP 500 with a Fault) is an answer, not a server error.
  const other = await setup({ clock });
  other.server.failuresOn.set('RetrievePropertiesEx', [
    { status: 500, body: faultXml('SystemError') },
  ]);
  clock.now += 60_000;
  await poll(other.timers);
  assert.equal(storeOf(other.dataDir).meta['pausedUntil|192.168.1.10:443'], undefined);
  assert.match(
    other.gladys.fake.connectionStatus.message.en,
    /reading failed: vSphere fault SystemError/,
  );
});

test('an expired session is renewed once; refused again after a new login: a spaced retry, no loop', async () => {
  const ctx = await setup();
  const { server, timers, clock, gladys } = ctx;
  server.dropSessions();
  clock.now += 60_000;
  await poll(timers);
  assert.equal(server.logins().length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  server.failuresOn.set('RetrievePropertiesEx', [
    { status: 500, body: faultXml('NotAuthenticated') },
    { status: 500, body: faultXml('NotAuthenticated') },
  ]);
  clock.now += 60_000;
  await poll(timers);
  assert.equal(server.logins().length, 3, 'one new login, not more');
  assert.match(gladys.fake.connectionStatus.message.en, /refuses the readings/);
  assert.deepEqual(timers.delays(), [60_000]);
});

test('never faster than the interval: reconnection, test button, unchanged configuration, scan, container restart', async () => {
  const clock = { now: T0 };
  const ctx = await setup({ clock });
  const { server, gladys, app } = ctx;
  const count = () => server.readings().length;
  assert.equal(count(), 1);
  clock.now += 20_000;
  await reconnect(gladys, app);
  assert.equal(count(), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true, 'from the last reading');
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true);
  await app.start({ ...BASE_CONFIG }, { force: true });
  await gladys.fake.scanRequest();
  assert.equal(count(), 1);
  // A restart of the container 30 s after the reading: /data says when.
  await app.stop();
  await app.flushAttempt();
  clock.now += 10_000;
  const again = await setup({ server, clock, dataDir: ctx.dataDir });
  assert.equal(count(), 1);
  assert.deepEqual(again.timers.delays(), [30_000]);
  clock.now += 30_000;
  await again.timers.run();
  assert.equal(count(), 2);
});

test('after a failure, a reconnection and the test button wait for the retry', async () => {
  const ctx = await setup();
  const { server, timers, clock, gladys, app } = ctx;
  server.unreachable = true;
  clock.now += 60_000;
  await poll(timers);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer/);
  const count = server.requests.length;
  clock.now += 10_000;
  await reconnect(gladys, app);
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
  assert.equal(server.requests.length, count);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer/);
});

test('a reconnection during a reading never starts a second one', async () => {
  const clock = { now: T0 };
  const server = createFakeVsphere({ clock });
  let release;
  server.gate = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = await setup({ server, clock, connect: false });
  const connecting = ctx.gladys.connect();
  await settle();
  ctx.gladys.emit('connected');
  await settle();
  release();
  server.gate = null;
  await connecting;
  await ctx.app.queue;
  await settle();
  assert.equal(server.readings().length, 1);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(ctx.timers.delays(), [60_000]);
});

test('a late reading of an old configuration publishes nothing and sets no status', async () => {
  const clock = { now: T0 };
  const ctx = await setup({ clock });
  const { server, timers, gladys, app } = ctx;
  let release;
  server.gate = new Promise((resolve) => {
    release = resolve;
  });
  clock.now += 60_000;
  const reading = poll(timers);
  await settle();
  server.gate = null;
  server.vms[0].powerState = 'poweredOff';
  // Other values saved meanwhile: the new client reads at once.
  await app.start({ ...BASE_CONFIG, host: '192.168.1.11' }, { force: true });
  const statuses = gladys.fake.connectionStatuses.length;
  const states = gladys.fake.states.length;
  release();
  await reading;
  await settle();
  assert.equal(gladys.fake.connectionStatuses.length, statuses);
  assert.equal(gladys.fake.states.length, states);
});

test('VM buttons: refused while off, for a reading feature, for a value other than 1', async () => {
  const ctx = await setup();
  const { gladys, server } = ctx;
  const count = server.requests.length;
  const ack = await press(gladys, VM2_UUID, 'start');
  assert.equal(ack.success, false);
  assert.match(ack.error, /not allowed/);
  const reading = await gladys.fake.setValue(
    buildVmDevice(ids, { uuid: VM_UUID }),
    { external_id: `${VM}:running` },
    0,
  );
  assert.match(reading.error, /only reads/);
  const host = await gladys.fake.setValue(
    buildHostDevice(ids, { id: 'ha-host' }),
    { external_id: `${HOST}:connected` },
    1,
  );
  assert.match(host.error, /only reads/);
  assert.equal(server.requests.length, count, 'nothing sent');
});

test('Start: the VM read again, powered on, confirmed by the state read again; cooldown in /data', async () => {
  const ctx = await setup({ config: ALLOW_ALL });
  const { gladys, server, clock } = ctx;
  const ack = await press(gladys, VM2_UUID, 'start');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.actions, [['PowerOnVM_Task', '2']]);
  assert.deepEqual(server.methods().slice(3), [
    'RetrievePropertiesEx',
    'PowerOnVM_Task',
    'RetrievePropertiesEx',
  ]);
  const key = `192.168.1.10:443|${VM2_UUID}`;
  assert.equal(Number(storeOf(ctx.dataDir).cooldowns[key]), clock.now);
  // A second press within the minute: refused, nothing sent.
  clock.now += 10_000;
  const again = await press(gladys, VM2_UUID, 'start');
  assert.match(again.error, /1 min between two actions/);
  assert.equal(server.actions.length, 1);
  await settle();
  assert.equal(last(gladys, `${VM2}:running`), 1);
  assertClean(ctx);
});

test('Start: already running is confirmed without sending; not confirmed in time says so', async () => {
  const ctx = await setup({ config: ALLOW_ALL });
  const { gladys, server } = ctx;
  const ack = await press(gladys, VM_UUID, 'start');
  assert.equal(ack.success, true);
  assert.equal(server.actions.length, 0);
  server.powerOn = 'later';
  server.connectMs.RetrievePropertiesEx = 0;
  server.delayMs = 1_000;
  const late = await press(gladys, VM2_UUID, 'start');
  assert.equal(late.success, false);
  assert.match(late.error, /sent, without confirmation/);
  assert.equal(server.actions.length, 1);
});

test('Shut down and Restart: asked to the guest, said sent without confirmation; never a power off', async () => {
  const ctx = await setup({ config: ALLOW_ALL });
  const { gladys, server, clock } = ctx;
  const ack = await press(gladys, VM_UUID, 'shutdown');
  assert.equal(ack.success, false);
  assert.match(ack.error, /sent to the guest system/);
  assert.deepEqual(server.actions, [['ShutdownGuest', '1']]);
  clock.now += 61_000;
  const restart = await press(gladys, VM_UUID, 'restart');
  assert.match(restart.error, /sent to the guest system/);
  assert.deepEqual(server.actions.at(-1), ['RebootGuest', '1']);
  for (const method of server.methods()) {
    assert.ok(!/PowerOff|Reset|Host|Standby|Maintenance|Destroy/.test(method), method);
  }
});

test('VM checks: tools not running, not running, another VM at the moref, an unreadable UUID', async () => {
  const ctx = await setup({ config: ALLOW_ALL });
  const { gladys, server } = ctx;
  let ack = await press(gladys, VM2_UUID, 'restart');
  assert.match(ack.error, /not running/);
  server.vms[1].powerState = 'poweredOn';
  ack = await press(gladys, VM2_UUID, 'shutdown');
  assert.match(ack.error, /VMware Tools does not run/);
  server.vms[0].instanceUuid = '50ffffff-0000-4000-8000-000000000000';
  ack = await press(gladys, VM_UUID, 'shutdown');
  assert.match(ack.error, /not the one read before/);
  server.vms[0].instanceUuid = null;
  ack = await press(gladys, VM_UUID, 'shutdown');
  assert.match(
    ack.error,
    /could not be read just before the action \(instance UUID not readable\)/,
  );
  server.vms = server.vms.slice(1);
  ack = await press(gladys, VM_UUID, 'shutdown');
  assert.match(ack.error, /no longer on the server/);
  assert.deepEqual(server.actions, []);
});

test('the option turned off during the handshakes: refused right before writing, nothing sent', async () => {
  const ctx = await setup({ config: ALLOW_ALL });
  const { gladys, server, app } = ctx;
  server.connectMs.ShutdownGuest = 1;
  const original = server.request;
  server.request = async (target, options) => {
    if (options.body.includes('<ShutdownGuest')) app.config.allowShutdown = false;
    return original(target, options);
  };
  app.request = server.request;
  app.client.request = server.request;
  const ack = await press(gladys, VM_UUID, 'shutdown');
  assert.match(ack.error, /not allowed/);
  assert.deepEqual(server.actions, []);
  assert.deepEqual(storeOf(ctx.dataDir).cooldowns, {});
});

test('too slow before sending: refused unsent after 3.5 s', async () => {
  const ctx = await setup({ config: ALLOW_ALL });
  const { gladys, server } = ctx;
  server.connectMs.ShutdownGuest = COMMAND.SEND_BY_MS + 1;
  const ack = await press(gladys, VM_UUID, 'shutdown');
  assert.match(ack.error, /did not answer in time: nothing was sent/);
  assert.deepEqual(server.actions, []);
});

test('NoPermission or a free-license refusal on an action never stops the readings', async () => {
  const ctx = await setup({ config: ALLOW_ALL });
  const { gladys, server, timers, clock } = ctx;
  server.failuresOn.set('PowerOnVM_Task', [{ status: 500, body: faultXml('RestrictedVersion') }]);
  const ack = await press(gladys, VM2_UUID, 'start');
  assert.match(ack.error, /refused the VM start \(forbidden by the license/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  clock.now += 60_000;
  await poll(timers);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(timers.delays().filter((d) => d === 60_000).length, 1);
});

test('a 5xx after an action was written: sent without confirmation, cooldown kept, pause followed', async () => {
  const ctx = await setup({ config: ALLOW_ALL });
  const { gladys, server, app } = ctx;
  server.failuresOn.set('PowerOnVM_Task', [{ status: 503, body: 'down' }]);
  const ack = await press(gladys, VM2_UUID, 'start');
  assert.match(ack.error, /was sent, without confirmation/);
  await app.following;
  assert.ok(storeOf(ctx.dataDir).cooldowns[`192.168.1.10:443|${VM2_UUID}`]);
  assert.ok(storeOf(ctx.dataDir).meta['pausedUntil|192.168.1.10:443']);
});

test('a published device never loses a feature; Discovery and status sent again at each connection', async () => {
  const created = buildVmDevice(ids, { uuid: VM_UUID });
  created.features.push({ ...created.features[0], external_id: `${VM}:legacy`, name: 'Legacy' });
  const ctx = await setup();
  ctx.gladys.devices.push(created);
  ctx.gladys.devices.splice(2, 1);
  const before = ctx.gladys.fake.discoveredDevices.length;
  await reconnect(ctx.gladys, ctx.app);
  const vm = ctx.gladys.fake.discoveredDevices.find((d) => d.external_id === VM);
  assert.ok(vm.features.some((f) => f.external_id === `${VM}:legacy`));
  assert.ok(ctx.gladys.fake.discoveredDevices.length >= before);
  assert.equal(ctx.gladys.fake.connectionStatuses.length >= 2, true);
});

test('pages: ContinueRetrievePropertiesEx until done', async () => {
  const clock = { now: T0 };
  const server = createFakeVsphere({ clock });
  server.pageSize = 2;
  const { gladys } = await setup({ server, clock });
  assert.deepEqual(server.methods(), [
    'RetrieveServiceContent',
    'Login',
    'RetrievePropertiesEx',
    'ContinueRetrievePropertiesEx',
  ]);
  assert.equal(last(gladys, `${VM2}:running`), 0);
});

test('the state budget holds across simultaneous publications', async () => {
  const ctx = await setup();
  const { app } = ctx;
  app.budget.entries = [[ctx.clock.now, 245]];
  app.published.clear();
  let calls = 0;
  const sizes = [];
  app.gladys.publishChangedStates = async (list) => {
    calls += 1;
    sizes.push(list.length);
    await settle();
  };
  await Promise.all([app.publishDeviceStates(), app.publishDeviceStates()]);
  assert.equal(
    sizes.reduce((a, b) => a + b, 0),
    5,
  );
  assert.ok(calls >= 1);
});

test('review 2 m1: a configuration saved during the refusal write keeps its good status', async () => {
  const ctx = await setup();
  const { app, server, timers, clock, gladys } = ctx;
  server.password = 'new-right-password';
  server.dropSessions();
  const set = app.store.set.bind(app.store);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let gated = true;
  app.store.set = async (section, key, value) => {
    if (section === 'refusals' && value && gated) {
      gated = false;
      const written = set(section, key, value);
      await gate;
      return written;
    }
    return set(section, key, value);
  };
  clock.now += 60_000;
  const loop = poll(timers);
  for (let i = 0; i < 50 && gated; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(gated, false, 'failed() waits in its refusal write');
  await app.start({ ...BASE_CONFIG, password: 'new-right-password' }, { force: true });
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  release();
  await loop;
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, true, 'never "refused" afterwards');
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /refused/);
  assert.equal(app.blocked, false);
});

test('review 2 m2: "Trust the new certificate" starts with the configuration saved before it', async () => {
  const ctx = await impostor();
  const { app, gladys } = ctx;
  const saved = app.start({ ...BASE_CONFIG, poll_interval: '120' }, { force: true });
  const ack = await gladys.fake.action(ACTIONS.TRUST);
  await saved;
  assert.equal(ack.success, true);
  assert.equal(app.config.pollSeconds, 120);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the start of an attempt is written to /data at most once a minute (a later one deferred)', async () => {
  const clock = { now: T0 };
  const ctx = await setup({ clock });
  const { app, timers } = ctx;
  const attemptOf = () => JSON.parse(storeOf(ctx.dataDir).meta['attempt|192.168.1.10:443']);
  assert.deepEqual(attemptOf(), { at: T0, delay: 60_000 });
  clock.now += 10_000;
  await app.noteAttempt(clock.now, null, 120_000, { persist: true });
  assert.equal(attemptOf().at, T0, 'not twice in a minute');
  assert.ok(timers.delays().includes(50_000));
  clock.now += 50_000;
  await timers.run((d) => d === 50_000);
  await settle();
  assert.deepEqual(attemptOf(), { at: T0 + 10_000, delay: 120_000 }, 'deferred, never dropped');
});

test('I3: a restart of the container 2 s after a reading STARTED waits for the interval', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'esxi-app-'));
  const clock = { now: T0 };
  const first = await setup({ dataDir, clock });
  clock.now += 60_000;
  first.server.gate = new Promise(() => {}); // the reading hangs, the container dies
  void first.timers.run((d) => d === 60_000);
  await settle();
  // The atomic write of /data lands (a real file).
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    storeOf(dataDir).meta['attempt|192.168.1.10:443'],
    JSON.stringify({ at: T0 + 60_000, delay: 60_000 }),
  );
  clock.now += 2_000;
  running = undefined;
  const server2 = createFakeVsphere({ clock });
  const second = await setup({ dataDir, clock, server: server2 });
  assert.equal(server2.requests.length, 0, 'no request before the interval');
  assert.deepEqual(second.timers.delays(), [58_000]);
});

test('I1: a configuration saved while failed() runs is never marked refused; the loop goes on', async () => {
  const ctx = await setup();
  const { app, server, timers, clock, gladys, dataDir } = ctx;
  server.password = 'new-right-password';
  server.dropSessions();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const original = gladys.publishTransports.bind(gladys);
  let gated = true;
  gladys.publishTransports = async (batch) => {
    if (gated) {
      gated = false;
      await gate;
    }
    return original(batch);
  };
  clock.now += 60_000;
  const loop = poll(timers);
  await settle();
  const saved = app.start({ ...BASE_CONFIG, password: 'new-right-password' }, { force: true });
  await settle();
  release();
  await loop;
  await saved;
  await settle();
  assert.equal(app.blocked, false);
  assert.equal(app.online, true);
  assert.deepEqual(storeOf(dataDir).refusals, {}, 'no fingerprint of the right password');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const before = server.readings().length;
  clock.now += 60_000;
  await poll(timers);
  assert.equal(server.readings().length, before + 1, 'the loop still reads');
});

test('I2: a VM action failing 5xx during the first reading never makes a second loop chain', async () => {
  const clock = { now: T0 };
  const ctx = await setup({ config: ALLOW_ALL, clock });
  const { app, timers, gladys, server } = ctx;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const original = gladys.publishChangedStates.bind(gladys);
  let gated = true;
  gladys.publishChangedStates = async (states) => {
    if (gated) {
      gated = false;
      await gate;
    }
    return original(states);
  };
  const started = app.start(
    { ...BASE_CONFIG, ...ALLOW_ALL, poll_interval: '120' },
    { force: true },
  );
  await settle();
  server.failuresOn.set('PowerOnVM_Task', [{ status: 503, body: 'busy' }]);
  const pressed = press(gladys, VM2_UUID, 'start');
  await settle();
  release();
  await pressed;
  await started;
  await app.following;
  await settle();
  const r0 = server.readings().length;
  for (let i = 0; i < 15; i += 1) {
    clock.now += 120_000;
    await timers.run();
    await settle();
  }
  assert.ok(server.readings().length - r0 <= 15, `${server.readings().length - r0} readings`);
  assert.ok(timers.delays().length <= 2, JSON.stringify(timers.delays()));
});

test('M5: a replaced client never logs in again with the old password', async () => {
  const ctx = await setup();
  const { app, server, timers, clock } = ctx;
  let release;
  server.gate = new Promise((resolve) => {
    release = resolve;
  });
  server.dropSessions();
  clock.now += 60_000;
  const reading = poll(timers);
  await settle();
  const old = app.client;
  const logins = server.logins().length;
  // Other values saved meanwhile (another address: the old reading is stale).
  server.gate = null;
  const saved = app.start({ ...BASE_CONFIG, host: '192.168.1.11' }, { force: true });
  release();
  await reading;
  await saved;
  await settle();
  assert.equal(old.closing, true);
  const oldLogins = server
    .logins()
    .slice(logins)
    .filter((r) => r.host === '192.168.1.10');
  assert.equal(oldLogins.length, 0);
});

test('M6: a VM connection state that cannot be read refuses the action', async () => {
  const ctx = await setup({ config: ALLOW_ALL });
  ctx.server.vms[0].connectionState = null;
  const ack = await press(ctx.gladys, VM_UUID, 'shutdown');
  assert.match(ack.error, /connection state not readable/);
  assert.deepEqual(ctx.server.actions, []);
});

test('M7: the cooldown is in /data before the request leaves; given back when it did not', async () => {
  const ctx = await setup({ config: ALLOW_ALL });
  const { gladys, server, dataDir } = ctx;
  const key = `192.168.1.10:443|${VM_UUID}`;
  let atSend;
  const original = server.request;
  server.request = async (target, options) => {
    if (options.body.includes('<ShutdownGuest')) atSend = storeOf(dataDir).cooldowns[key];
    return original(target, options);
  };
  ctx.app.client.request = server.request;
  await press(gladys, VM_UUID, 'shutdown');
  assert.ok(atSend, 'written before the request');
  // Not sent (too slow): the cooldown is given back.
  const other = await setup({ config: ALLOW_ALL });
  other.server.connectMs.ShutdownGuest = COMMAND.SEND_BY_MS + 1;
  await press(other.gladys, VM_UUID, 'shutdown');
  assert.equal(storeOf(other.dataDir).cooldowns[key], undefined);
});

test('M8: a login answered without a cookie fails, retried spaced, one login per attempt', async () => {
  const clock = { now: T0 };
  const server = createFakeVsphere({ clock });
  const answer = server.answer;
  server.answer = (body, headers) => {
    const result = answer(body, headers);
    if (body.includes('<Login ')) delete result.headers['set-cookie'];
    return result;
  };
  const ctx = await setup({ server, clock });
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.equal(server.logins().length, 1);
  assert.deepEqual(ctx.timers.delays(), [60_000]);
  clock.now += 60_000;
  await ctx.timers.run();
  assert.equal(server.logins().length, 2);
});

test('M9: the loop never reads within the interval after an attempt of the scan', async () => {
  const ctx = await setup();
  const { app, server, timers, clock, gladys } = ctx;
  clock.now += 60_000 - 1;
  app.online = true;
  // The scan reads just before the loop's timer.
  app.attempts.set('192.168.1.10:443', { at: T0 - 1, failed: false, delay: 0 });
  await gladys.fake.scanRequest();
  const count = server.readings().length;
  clock.now += 1;
  await poll(timers);
  assert.equal(server.readings().length, count, 'no second reading at once');
});
