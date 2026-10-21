// -----------------------------------------------------------------------------
// The vSphere Web Services API (SOAP, vim25) of an ESXi host or a vCenter,
// limited to the calls this integration needs (the methods and their
// parameters as pyVmomi describes them, Apache-2.0, see
// THIRD_PARTY_NOTICES.md):
//
//   RetrieveServiceContent        no secret: the root folder, the property
//                                 collector, the session manager, `about`;
//                                 learns the certificate on first use
//   Login / Logout                SessionManager, a `vmware_soap_session` cookie
//   RetrievePropertiesEx          the hosts, datastores and VMs in one call
//   ContinueRetrievePropertiesEx  (traversal from the root folder), paged and
//   CancelRetrievePropertiesEx    bounded
//   PowerOnVM_Task                start a VM
//   ShutdownGuest / RebootGuest   ask the guest system (VMware Tools) to shut
//                                 down / restart cleanly
//
// Nothing else: no power off, no reset, no host shutdown, reboot, standby or
// maintenance mode, no view, no task follow-up, no event collector.
//
// The password is sent only by Login, only on a connection whose certificate
// matched the pin (the transport refuses it otherwise). A session the server
// no longer knows (NotAuthenticated) is renewed ONCE per reading, never in a
// loop; a command never logs in. The password and the cookie are never in a
// log, an error message or /data.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { LIMITS, MAX_BYTES, SOAP_ACTION, SOAP_PATH, TIMEOUTS } from '../constants.js';
import { CODES, VsphereError } from './errors.js';
import { httpRequest } from './http.js';
import {
  DATASTORE_PROPS,
  HOST_PROPS,
  MOREF_VALUE,
  VM_CHECK_PROPS,
  VM_PROPS,
  parseAbout,
  parseVmCheck,
} from './parse.js';
import { el, envelope, moref, morefXml, readAnswer, readObjects, returnval } from './soap.js';
import { childOf, elementsOf, textOf } from './xml.js';

/** Seconds of a Retry-After header (delta form only), in ms, or null. */
const retryAfterMs = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\d{1,8}$/.test(raw.trim())) return null;
  return Number(raw.trim()) * 1000;
};

/** gladys-esxi/<version>, from package.json (copied into the image). */
export const USER_AGENT = (() => {
  try {
    const { version } = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    return typeof version === 'string' ? `gladys-esxi/${version}` : 'gladys-esxi';
  } catch {
    return 'gladys-esxi';
  }
})();

const COOKIE = /(?:^|[;,\s])vmware_soap_session=("[^"\s;,]{1,200}"|[^"\s;,]{1,200})/;

/** The session cookie of a Set-Cookie header, as `name=value`, or null. */
export function sessionCookie(header) {
  for (const line of Array.isArray(header) ? header : [header]) {
    if (typeof line !== 'string') continue;
    const match = COOKIE.exec(line);
    if (match) return `vmware_soap_session=${match[1]}`;
  }
  return null;
}

/** A moref element of the ServiceContent: { type, value } or null. */
const refOf = (parent, name) => {
  const node = childOf(parent, name);
  const value = node ? textOf(node).trim() : '';
  const type = node?.attrs.type ?? '';
  return MOREF_VALUE.test(value) && /^[A-Za-z]{1,40}$/.test(type) ? moref(type, value) : null;
};

const propSet = (type, paths) =>
  `<propSet>${el('type', type)}<all>false</all>${paths.map((p) => el('pathSet', p)).join('')}</propSet>`;

const traversal = (name, type, path, next = []) =>
  `<selectSet xsi:type="TraversalSpec">${el('name', name)}${el('type', type)}${el('path', path)}<skip>false</skip>${next
    .map((n) => `<selectSet>${el('name', n)}</selectSet>`)
    .join('')}</selectSet>`;

/**
 * From the root folder: folders (recursively), datacenters (their VM, host
 * folders and datastores), compute resources and clusters (their hosts),
 * vApps (their VMs). Only HostSystem, Datastore and VirtualMachine have a
 * propSet: nothing else comes back.
 */
function inventorySpec(root) {
  const all = ['folder', 'dcVm', 'dcHost', 'dcDatastore', 'crHost', 'vappVm'];
  return `<specSet>${propSet('HostSystem', HOST_PROPS)}${propSet('Datastore', DATASTORE_PROPS)}${propSet(
    'VirtualMachine',
    VM_PROPS,
  )}<objectSet>${morefXml('obj', root)}<skip>false</skip>${traversal(
    'folder',
    'Folder',
    'childEntity',
    all,
  )}${traversal('dcVm', 'Datacenter', 'vmFolder', ['folder'])}${traversal(
    'dcHost',
    'Datacenter',
    'hostFolder',
    ['folder'],
  )}${traversal('dcDatastore', 'Datacenter', 'datastore')}${traversal(
    'crHost',
    'ComputeResource',
    'host',
  )}${traversal('vappVm', 'VirtualApp', 'vm')}</objectSet></specSet>`;
}

const options = () => `<options>${el('maxObjects', LIMITS.PAGE_OBJECTS)}</options>`;

export class VsphereClient {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} options.port
   * @param {string} options.username
   * @param {string} options.password
   * @param {string|null} [options.pin] the certificate fingerprint (typed or learned earlier)
   * @param {(fingerprint: string) => Promise<void>} [options.onPin] a certificate learned now
   * @param {Function} [options.request] the HTTPS transport (tests inject a fake server)
   * @param {() => number} [options.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    host,
    port,
    username,
    password,
    pin = null,
    onPin,
    request = httpRequest,
    now = Date.now,
    timers = globalThis,
  }) {
    this.target = { host, port, path: SOAP_PATH };
    this.username = username;
    this.password = password;
    this.pin = pin;
    this.onPin = onPin;
    this.request = request;
    this.now = now;
    this.timers = timers;
    this.cookie = null;
    this.content = null;
    this.closed = false;
    /** The login in flight, shared (single flight). */
    this.loggingIn = null;
  }

  /** Closed: nothing sent any more. The session is left to expire, or logged out by `logout()`. */
  close() {
    this.closed = true;
  }

  /** One SOAP exchange within `deadline` (ms since epoch). Resolves the response element. */
  async send(method, self, params, options) {
    return (await this.exchange(method, self, params, options)).element;
  }

  /** One SOAP exchange: { element, setCookie }. */
  async exchange(
    method,
    self,
    params,
    { deadline, secret = true, beforeSend, cookie = true } = {},
  ) {
    if (this.closed) throw new VsphereError(CODES.CLOSED, 'Client closed', { notSent: true });
    const left = Math.min(TIMEOUTS.API, (deadline ?? Infinity) - this.now());
    if (left <= 0) throw new VsphereError(CODES.LATE, 'Too late to send', { notSent: true });
    const headers = { 'user-agent': USER_AGENT, soapaction: SOAP_ACTION };
    if (cookie && this.cookie) headers.cookie = this.cookie;
    const response = await this.request(this.target, {
      headers,
      body: envelope(method, self, params),
      timeout: left,
      maxBytes: MAX_BYTES,
      pin: this.pin,
      secret,
      beforeSend,
    });
    if (!this.pin && response.fingerprint) {
      // Trust on first use: the certificate met now (by a request without a
      // secret) is the one from now on.
      this.pin = response.fingerprint;
      await this.onPin?.(response.fingerprint);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new VsphereError(CODES.REDIRECT, `HTTP ${response.status}`, {
        status: response.status,
      });
    }
    if (response.status === 429 || (response.status > 500 && response.status < 600)) {
      throw new VsphereError(CODES.HTTP, `HTTP ${response.status}`, {
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers?.['retry-after']),
      });
    }
    if (response.status !== 200 && response.status !== 500) {
      throw new VsphereError(CODES.HTTP, `HTTP ${response.status}`, { status: response.status });
    }
    // A 500 is a SOAP fault, or a server error when it is not SOAP.
    try {
      return {
        element: readAnswer(response.body, response.status),
        setCookie: response.headers?.['set-cookie'] ?? null,
      };
    } catch (err) {
      if (err?.code === CODES.HTTP && err.status === 500) {
        err.retryAfterMs = retryAfterMs(response.headers?.['retry-after']) ?? undefined;
      }
      throw err;
    }
  }

  /** RetrieveServiceContent, once per client: the morefs and `about`. No secret. */
  async serviceContent(deadline) {
    if (this.content) return this.content;
    const response = await this.send(
      'RetrieveServiceContent',
      moref('ServiceInstance', 'ServiceInstance'),
      '',
      { deadline, secret: false, cookie: false },
    );
    const content = returnval(response);
    const about = childOf(content, 'about');
    const fields = Object.fromEntries(
      elementsOf(about).map((node) => [node.name, textOf(node).trim()]),
    );
    const parsed = {
      rootFolder: refOf(content, 'rootFolder'),
      propertyCollector: refOf(content, 'propertyCollector'),
      sessionManager: refOf(content, 'sessionManager'),
      about: parseAbout(fields),
    };
    if (
      !parsed.rootFolder ||
      !parsed.propertyCollector ||
      !parsed.sessionManager ||
      !parsed.about.apiType
    ) {
      throw new VsphereError(CODES.BAD_ANSWER, 'Not a vSphere service content');
    }
    this.content = parsed;
    return parsed;
  }

  /**
   * Login: a new session cookie. Rejects CREDENTIALS when the server refuses
   * them (InvalidLogin). One login at a time (single flight); each caller
   * waits until its own deadline only.
   */
  login(deadline) {
    if (!this.loggingIn) {
      this.loggingIn = this.#login(deadline).finally(() => {
        this.loggingIn = null;
      });
      this.loggingIn.catch(() => {});
    }
    const shared = this.loggingIn;
    if (deadline === undefined || deadline === Infinity) return shared;
    const left = deadline - this.now();
    if (left <= 0) {
      return Promise.reject(new VsphereError(CODES.LATE, 'Too late', { notSent: true }));
    }
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(
        () => reject(new VsphereError(CODES.LATE, 'A login is still running', { notSent: true })),
        left,
      );
    });
    return Promise.race([shared, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  async #login(deadline) {
    const content = await this.serviceContent(deadline);
    const params = `${el('userName', this.username)}${el('password', this.password)}`;
    // `secret: true`: never on a connection whose certificate was not checked.
    const { element, setCookie } = await this.exchange('Login', content.sessionManager, params, {
      deadline,
      cookie: false,
    });
    if (!returnval(element)) throw new VsphereError(CODES.BAD_ANSWER, 'Not a login answer');
    const cookie = sessionCookie(setCookie);
    if (!cookie) throw new VsphereError(CODES.BAD_ANSWER, 'No session cookie');
    this.cookie = cookie;
  }

  /** A logged-in session (the cookie of the last login). */
  async ensureSession(deadline) {
    await this.serviceContent(deadline);
    if (!this.cookie) await this.login(deadline);
  }

  /**
   * A call with the session; a session the server no longer knows is renewed
   * once, then the call fails (ACCESS: refused right after a new login).
   */
  async call(method, self, params, deadline) {
    await this.ensureSession(deadline);
    try {
      return await this.send(method, self, params, { deadline });
    } catch (err) {
      if (err?.code !== CODES.SESSION) throw err;
      this.cookie = null;
      await this.login(deadline);
      try {
        return await this.send(method, self, params, { deadline });
      } catch (again) {
        if (again?.code === CODES.SESSION) {
          this.cookie = null;
          throw new VsphereError(CODES.ACCESS, 'Session refused after a new login', {
            fault: 'NotAuthenticated',
          });
        }
        throw again;
      }
    }
  }

  /**
   * The hosts, datastores and VMs: { objects, about }. Paged; past the caps
   * the rest is cancelled (best effort) and ignored.
   */
  async inventory(deadline) {
    const content = await this.serviceContent(deadline);
    const pc = content.propertyCollector;
    let page = readObjects(
      await this.call(
        'RetrievePropertiesEx',
        pc,
        `${inventorySpec(content.rootFolder)}${options()}`,
        deadline,
      ),
    );
    const objects = [...page.objects];
    let pages = 1;
    const cap = LIMITS.HOSTS + LIMITS.DATASTORES + LIMITS.VMS;
    while (page.token && pages < LIMITS.PAGES && objects.length < cap) {
      page = readObjects(
        await this.call('ContinueRetrievePropertiesEx', pc, el('token', page.token), deadline),
      );
      objects.push(...page.objects);
      pages += 1;
    }
    if (page.token) {
      await this.call('CancelRetrievePropertiesEx', pc, el('token', page.token), deadline).catch(
        () => {},
      );
    }
    return { objects, about: content.about, truncated: Boolean(page.token) };
  }

  /**
   * The state of one VM, read again just before or after an action. Never a
   * login: without a session, or with one the server no longer knows, it
   * fails `noSession` (unsent: nothing changed on the server).
   */
  async vmCheck(vmMoref, deadline) {
    if (!this.cookie || !this.content) {
      throw Object.assign(new VsphereError(CODES.LATE, 'No session', { notSent: true }), {
        noSession: true,
      });
    }
    const spec = `<specSet>${propSet('VirtualMachine', VM_CHECK_PROPS)}<objectSet>${morefXml(
      'obj',
      moref('VirtualMachine', vmMoref),
    )}<skip>false</skip></objectSet></specSet>${options()}`;
    let response;
    try {
      response = await this.send('RetrievePropertiesEx', this.content.propertyCollector, spec, {
        deadline,
      });
    } catch (err) {
      if (err?.code === CODES.SESSION) {
        this.cookie = null;
        throw Object.assign(err, { noSession: true });
      }
      throw err;
    }
    const { objects } = readObjects(response);
    const object = objects.find((o) => o.type === 'VirtualMachine' && o.id === vmMoref);
    if (!object) throw new VsphereError(CODES.NOT_FOUND, 'VM not found');
    return parseVmCheck(object);
  }

  /**
   * One VM action, once, never retried, never preceded by a login. `method`:
   * PowerOnVM_Task, ShutdownGuest or RebootGuest only. Refused unsent (LATE)
   * after `sendBy`; answered by `answerBy`.
   */
  async vmAction(method, vmMoref, { sendBy, answerBy, beforeSend }) {
    if (!['PowerOnVM_Task', 'ShutdownGuest', 'RebootGuest'].includes(method)) {
      throw new VsphereError(CODES.FAULT, 'Not an action of this integration', { notSent: true });
    }
    if (!this.cookie) {
      throw Object.assign(new VsphereError(CODES.LATE, 'No session', { notSent: true }), {
        noSession: true,
      });
    }
    if (this.now() > sendBy) throw new VsphereError(CODES.LATE, 'Too late', { notSent: true });
    try {
      await this.send(method, moref('VirtualMachine', vmMoref), '', {
        deadline: answerBy,
        beforeSend,
      });
    } catch (err) {
      if (err?.code === CODES.SESSION) this.cookie = null;
      throw err;
    }
  }

  /** Logout (a stop, a new configuration): best effort, bounded, the cookie dropped. */
  async logout() {
    const content = this.content;
    if (!this.cookie || !content || this.closed) {
      this.cookie = null;
      return;
    }
    try {
      await this.send('Logout', content.sessionManager, '', {
        deadline: this.now() + TIMEOUTS.LOGOUT,
      });
    } catch {
      // The server forgets an idle session by itself.
    } finally {
      this.cookie = null;
    }
  }
}
