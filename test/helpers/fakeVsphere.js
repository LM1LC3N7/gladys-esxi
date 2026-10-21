// -----------------------------------------------------------------------------
// A fake vSphere Web Services endpoint (in memory): answers the SOAP calls of
// src/vsphere/client.js like an ESXi host (`HostAgent`) or a vCenter
// (`VirtualCenter`). The shapes follow the vim25 WSDL as pyVmomi describes it;
// never checked against a real server (TODO.md). `answer()` serves both the
// in-memory transport (`fake.request`) and a real loopback HTTPS server.
// -----------------------------------------------------------------------------

import { CODES, VsphereError } from '../../src/vsphere/errors.js';
import { childOf, childrenOf, elementsOf, parseXml, textOf } from '../../src/vsphere/xml.js';

export const USERNAME = 'gladys';
export const PASSWORD = 'fake Esxi pass-0123';
export const COOKIE_PREFIX = 'fakeSessionCookie';
export const FINGERPRINT =
  'AA:11:BB:22:CC:33:DD:44:EE:55:FF:66:00:77:11:88:22:99:33:AA:44:BB:55:CC:66:DD:77:EE:88:FF:99:00';
/** Never in a log, a state, Discovery, a status or /data. */
export const SECRETS = [PASSWORD, COOKIE_PREFIX, '192.168.77.5', 'secret-guest-host'];

export const VM_UUID = '5012a3b4-c5d6-47e8-9f01-23456789abcd';
export const VM2_UUID = '50aabbcc-ddee-4f00-8111-222233334444';

export function hostObject(overrides = {}) {
  return {
    moref: 'ha-host',
    name: 'esxi01.lan',
    vendor: 'Dell Inc.',
    model: 'OptiPlex 7070',
    cpuMhz: 3000,
    cores: 8,
    memorySize: 32 * 1024 * 1024 * 1024,
    cpuUsage: 6000,
    memoryUsage: 16384,
    uptime: 7200,
    connectionState: 'connected',
    powerState: 'poweredOn',
    maintenance: false,
    status: 'green',
    product: 'VMware ESXi 8.0.3 build-24022510',
    ...overrides,
  };
}

export function datastoreObject(overrides = {}) {
  return {
    moref: '5f1a2b3c-4d5e6f70-1a2b-001122334455',
    name: 'datastore1',
    type: 'VMFS',
    capacity: 500e9,
    freeSpace: 125e9,
    accessible: true,
    ...overrides,
  };
}

export function vmObject(overrides = {}) {
  return {
    moref: '1',
    name: 'home-assistant',
    instanceUuid: VM_UUID,
    template: false,
    powerState: 'poweredOn',
    connectionState: 'connected',
    host: 'ha-host',
    numCpu: 2,
    memorySizeMB: 4096,
    cpuUsage: 1500,
    hostMemoryUsage: 2048,
    uptimeSeconds: 3600,
    status: 'green',
    tools: 'guestToolsRunning',
    // Never asked for: they must never come out.
    guestHostName: 'secret-guest-host',
    ipAddress: '192.168.77.5',
    ...overrides,
  };
}

const xsd = (type, value) => `<val xsi:type="xsd:${type}">${value}</val>`;
const prop = (name, val) => (val === null ? '' : `<propSet><name>${name}</name>${val}</propSet>`);
const str = (v) => (v === undefined || v === null ? null : xsd('string', escape(String(v))));
const int = (v, type = 'int') => (v === undefined || v === null ? null : xsd(type, v));
const bool = (v) => (v === undefined || v === null ? null : xsd('boolean', String(v)));
const enumVal = (type, v) =>
  v === undefined || v === null ? null : `<val xsi:type="${type}">${v}</val>`;
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function hostProps(h) {
  return {
    name: str(h.name),
    'summary.hardware.vendor': str(h.vendor),
    'summary.hardware.model': str(h.model),
    'summary.hardware.cpuMhz': int(h.cpuMhz),
    'summary.hardware.numCpuCores': int(h.cores, 'short'),
    'summary.hardware.memorySize': int(h.memorySize, 'long'),
    'summary.quickStats.overallCpuUsage': int(h.cpuUsage),
    'summary.quickStats.overallMemoryUsage': int(h.memoryUsage),
    'summary.quickStats.uptime': int(h.uptime),
    'summary.runtime.connectionState': enumVal('HostSystemConnectionState', h.connectionState),
    'summary.runtime.powerState': enumVal('HostSystemPowerState', h.powerState),
    'summary.runtime.inMaintenanceMode': bool(h.maintenance),
    'summary.overallStatus': enumVal('ManagedEntityStatus', h.status),
    'summary.config.product.fullName': str(h.product),
  };
}

function datastoreProps(d) {
  return {
    'summary.name': str(d.name),
    'summary.type': str(d.type),
    'summary.capacity': int(d.capacity, 'long'),
    'summary.freeSpace': int(d.freeSpace, 'long'),
    'summary.accessible': bool(d.accessible),
  };
}

function vmProps(v) {
  return {
    name: str(v.name),
    'config.instanceUuid': str(v.instanceUuid),
    'config.template': bool(v.template),
    'runtime.powerState': enumVal('VirtualMachinePowerState', v.powerState),
    'runtime.connectionState': enumVal('VirtualMachineConnectionState', v.connectionState),
    'runtime.host': v.host
      ? `<val xsi:type="ManagedObjectReference" type="HostSystem">${v.host}</val>`
      : null,
    'summary.config.numCpu': int(v.numCpu),
    'summary.config.memorySizeMB': int(v.memorySizeMB),
    'summary.quickStats.overallCpuUsage': int(v.cpuUsage),
    'summary.quickStats.hostMemoryUsage': int(v.hostMemoryUsage),
    'summary.quickStats.uptimeSeconds': int(v.uptimeSeconds),
    'summary.overallStatus': enumVal('ManagedEntityStatus', v.status),
    'guest.toolsRunningStatus': str(v.tools),
    'guest.hostName': str(v.guestHostName),
    'guest.ipAddress': str(v.ipAddress),
  };
}

const ENVELOPE = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n<soapenv:Body>${body}</soapenv:Body>\n</soapenv:Envelope>`;

export const faultXml = (type, text = 'A fault with a name: home-assistant') =>
  ENVELOPE(
    `<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${text}</faultstring><detail><${type}Fault xmlns="urn:vim25" xsi:type="${type}"></${type}Fault></detail></soapenv:Fault>`,
  );

export function createFakeVsphere({ clock, apiType = 'HostAgent' } = {}) {
  let sessions = 0;
  const fake = {
    apiType,
    requests: [],
    username: USERNAME,
    password: PASSWORD,
    fingerprint: FINGERPRINT,
    /** Cookies the server still accepts. */
    valid: new Set(),
    hosts: [hostObject()],
    datastores: [datastoreObject()],
    vms: [
      vmObject(),
      vmObject({
        moref: '2',
        name: 'nas',
        instanceUuid: VM2_UUID,
        powerState: 'poweredOff',
        tools: 'guestToolsNotRunning',
        uptimeSeconds: 0,
        cpuUsage: 0,
        hostMemoryUsage: 0,
      }),
    ],
    /** { status, headers, body } answered once each (FIFO), any method. */
    failures: [],
    /** method -> [{ status, headers, body }] answered once each. */
    failuresOn: new Map(),
    unreachable: false,
    /** A promise every request waits for before answering. */
    gate: null,
    /** ms the clock moves on during a request (a slow server). */
    delayMs: 0,
    /** method -> ms the clock moves on during the handshakes, before beforeSend. */
    connectMs: {},
    /** What PowerOnVM_Task does: 'on' (at once) | 'later' (stays off) | 'timeout'. */
    powerOn: 'on',
    actions: [],
    /** Objects per page when the client asks more (maxObjects). */
    pageSize: Infinity,
    pages: new Map(),
  };

  const ok = (method, inner = '') => ({
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
    body: Buffer.from(
      ENVELOPE(`<${method}Response xmlns="urn:vim25">${inner}</${method}Response>`),
    ),
  });
  const fault = (type) => ({
    status: 500,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
    body: Buffer.from(faultXml(type)),
  });

  const sc = () =>
    fake.apiType === 'HostAgent'
      ? {
          root: 'ha-folder-root',
          pc: 'ha-property-collector',
          sm: 'ha-sessionmgr',
          name: 'VMware ESXi',
          full: 'VMware ESXi 8.0.3 build-24022510',
        }
      : {
          root: 'group-d1',
          pc: 'propertyCollector',
          sm: 'SessionManager',
          name: 'VMware vCenter Server',
          full: 'VMware vCenter Server 8.0.3 build-24091160',
        };

  function objectXml(type, moref, props, paths) {
    const sets = paths.map((p) => prop(p, props[p] ?? null)).join('');
    const missing = paths
      .filter((p) => (props[p] ?? null) === null)
      .map(
        (p) =>
          `<missingSet><path>${p}</path><fault><fault xsi:type="NotFound"/></fault></missingSet>`,
      )
      .join('');
    return `<objects><obj type="${type}">${moref}</obj>${sets}${missing}</objects>`;
  }

  function page(objects) {
    if (objects.length <= fake.pageSize) return objects.join('');
    const token = `token${fake.pages.size + 1}`;
    fake.pages.set(token, objects.slice(fake.pageSize));
    return `<token>${token}</token>${objects.slice(0, fake.pageSize).join('')}`;
  }

  function retrieve(call) {
    const spec = childOf(call, 'specSet');
    const propSets = new Map(
      childrenOf(spec, 'propSet').map((p) => [
        textOf(childOf(p, 'type')).trim(),
        childrenOf(p, 'pathSet').map((x) => textOf(x).trim()),
      ]),
    );
    const objectSet = childOf(spec, 'objectSet');
    const obj = childOf(objectSet, 'obj');
    const target = { type: obj.attrs.type, value: textOf(obj).trim() };
    const out = [];
    if (target.type === 'Folder') {
      if (target.value !== sc().root) return fault('ManagedObjectNotFound');
      if (elementsOf(objectSet).filter((e) => e.name === 'selectSet').length < 6) {
        return fault('InvalidArgument');
      }
      for (const h of fake.hosts) {
        if (propSets.has('HostSystem'))
          out.push(objectXml('HostSystem', h.moref, hostProps(h), propSets.get('HostSystem')));
      }
      for (const d of fake.datastores) {
        if (propSets.has('Datastore'))
          out.push(objectXml('Datastore', d.moref, datastoreProps(d), propSets.get('Datastore')));
      }
      for (const v of fake.vms) {
        if (propSets.has('VirtualMachine'))
          out.push(
            objectXml('VirtualMachine', v.moref, vmProps(v), propSets.get('VirtualMachine')),
          );
      }
    } else if (target.type === 'VirtualMachine') {
      const v = fake.vms.find((x) => x.moref === target.value);
      if (!v) return fault('ManagedObjectNotFound');
      out.push(
        objectXml('VirtualMachine', v.moref, vmProps(v), propSets.get('VirtualMachine') ?? []),
      );
    } else {
      return fault('InvalidArgument');
    }
    return ok('RetrievePropertiesEx', out.length ? `<returnval>${page(out)}</returnval>` : '');
  }

  /** The answer to one SOAP request body (a string) with these headers. */
  fake.answer = (body, headers = {}) => {
    const root = parseXml(body);
    const call = elementsOf(childOf(root, 'Body'))[0];
    const method = call.name;
    const self = childOf(call, '_this');
    const once = fake.failuresOn.get(method);
    if (once?.length) {
      const f = once.shift();
      return { status: f.status, headers: f.headers ?? {}, body: Buffer.from(f.body ?? '') };
    }
    if (fake.failures.length > 0) {
      const f = fake.failures.shift();
      return { status: f.status, headers: f.headers ?? {}, body: Buffer.from(f.body ?? '') };
    }
    if (method === 'RetrieveServiceContent') {
      const s = sc();
      const about = `<about><name>${s.name}</name><fullName>${s.full}</fullName><vendor>VMware, Inc.</vendor><version>8.0.3</version><apiType>${fake.apiType}</apiType><apiVersion>8.0.3.0</apiVersion></about>`;
      return ok(
        method,
        `<returnval><rootFolder type="Folder">${s.root}</rootFolder><propertyCollector type="PropertyCollector">${s.pc}</propertyCollector><viewManager type="ViewManager">ViewManager</viewManager>${about}<sessionManager type="SessionManager">${s.sm}</sessionManager></returnval>`,
      );
    }
    if (method === 'Login') {
      if (textOf(self).trim() !== sc().sm) return fault('ManagedObjectNotFound');
      const user = textOf(childOf(call, 'userName'));
      const pass = textOf(childOf(call, 'password'));
      if (user !== fake.username || pass !== fake.password) return fault('InvalidLogin');
      sessions += 1;
      const cookie = `"${COOKIE_PREFIX}${sessions}abc"`;
      fake.valid.add(`vmware_soap_session=${cookie}`);
      const answer = ok(
        method,
        `<returnval><key>52${sessions}</key><userName>${user}</userName></returnval>`,
      );
      answer.headers['set-cookie'] = [`vmware_soap_session=${cookie}; Path=/; HttpOnly; Secure;`];
      return answer;
    }
    if (!fake.valid.has(headers.cookie ?? '')) return fault('NotAuthenticated');
    if (method === 'Logout') {
      fake.valid.delete(headers.cookie);
      return ok(method);
    }
    if (method === 'RetrievePropertiesEx') return retrieve(call);
    if (method === 'ContinueRetrievePropertiesEx') {
      const token = textOf(childOf(call, 'token')).trim();
      const rest = fake.pages.get(token);
      if (!rest) return fault('InvalidArgument');
      fake.pages.delete(token);
      return ok(method, `<returnval>${page(rest)}</returnval>`);
    }
    if (method === 'CancelRetrievePropertiesEx') {
      fake.pages.delete(textOf(childOf(call, 'token')).trim());
      return ok(method);
    }
    const vm = fake.vms.find((v) => v.moref === textOf(self).trim());
    if (['PowerOnVM_Task', 'ShutdownGuest', 'RebootGuest'].includes(method)) {
      fake.actions.push([method, textOf(self).trim()]);
      if (!vm) return fault('ManagedObjectNotFound');
      if (method === 'PowerOnVM_Task') {
        if (vm.powerState === 'poweredOn') return fault('InvalidPowerState');
        if (fake.powerOn === 'on') vm.powerState = 'poweredOn';
        return ok(method, '<returnval type="Task">task-42</returnval>');
      }
      if (vm.tools !== 'guestToolsRunning') return fault('ToolsUnavailable');
      return ok(method);
    }
    return fault('MethodNotFound');
  };

  /** The transport of src/vsphere/http.js, in memory. */
  fake.request = async (target, options = {}) => {
    if (fake.gate) await fake.gate;
    if (fake.unreachable) {
      throw new VsphereError(CODES.UNREACHABLE, 'ECONNREFUSED', { notSent: true });
    }
    if (options.secret && !options.pin) {
      throw new VsphereError(CODES.NO_PIN, 'No pinned certificate yet', { notSent: true });
    }
    if (options.pin && options.pin !== fake.fingerprint) {
      throw Object.assign(
        new VsphereError(CODES.CERTIFICATE, 'Another certificate', { notSent: true }),
        { fingerprint: fake.fingerprint },
      );
    }
    const method = /<([A-Za-z_]+) xmlns="urn:vim25">/.exec(options.body)?.[1];
    // The TCP and TLS handshakes of a slow server, before anything is written.
    if (clock && fake.connectMs[method]) clock.now += fake.connectMs[method];
    if (options.beforeSend) {
      try {
        options.beforeSend();
      } catch (err) {
        throw Object.assign(err, { notSent: true, beforeSend: true });
      }
    }
    fake.requests.push({
      ...target,
      method,
      headers: options.headers ?? {},
      body: options.body,
      pin: options.pin,
      secret: options.secret,
    });
    if (clock && fake.delayMs) {
      if (fake.delayMs > options.timeout) {
        clock.now += options.timeout;
        throw new VsphereError(CODES.TIMEOUT, 'No answer in time');
      }
      clock.now += fake.delayMs;
    }
    if (method === 'PowerOnVM_Task' && fake.powerOn === 'timeout') {
      fake.actions.push([method, 'timeout']);
      throw new VsphereError(CODES.TIMEOUT, 'No answer within 1 s');
    }
    const result = fake.answer(options.body, options.headers ?? {});
    return { ...result, fingerprint: fake.fingerprint };
  };

  fake.methods = () => fake.requests.map((r) => r.method);
  fake.logins = () => fake.requests.filter((r) => r.method === 'Login');
  fake.readings = () => fake.requests.filter((r) => r.method === 'RetrievePropertiesEx');
  /** The server forgets every session (a restart of hostd, an idle timeout). */
  fake.dropSessions = () => fake.valid.clear();
  return fake;
}
