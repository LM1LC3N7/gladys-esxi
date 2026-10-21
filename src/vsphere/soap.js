// -----------------------------------------------------------------------------
// The SOAP envelopes of the vSphere Web Services API (vim25) and the reading
// of their answers (pure). The shape follows pyVmomi's SoapAdapter
// (Apache-2.0, see THIRD_PARTY_NOTICES.md): a body element named after the
// method in the `urn:vim25` namespace, its `_this` managed object reference
// first, then the parameters in the order of the WSDL; a fault comes back as
// HTTP 500 with a `soapenv:Fault` whose `detail` names its type.
// -----------------------------------------------------------------------------

import { CODES, FAULT_CODES, VsphereError } from './errors.js';
import { XmlError, childOf, elementsOf, escapeXml, parseXml, textOf } from './xml.js';

const ENVELOPE_START =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"' +
  ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"' +
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>';
const ENVELOPE_END = '</soapenv:Body></soapenv:Envelope>';

/** A managed object reference: { type, value }. Its XML: `<name type="T">value</name>`. */
export const moref = (type, value) => ({ type, value });
export const morefXml = (name, ref) =>
  `<${name} type="${escapeXml(ref.type)}">${escapeXml(ref.value)}</${name}>`;

/** One element per value; nested arrays are written in order. */
export const el = (name, value) => `<${name}>${escapeXml(value)}</${name}>`;

/**
 * The envelope of `method` on `_this`; `params` is the XML of the parameters,
 * already in the order of the WSDL.
 */
export function envelope(method, self, params = '') {
  return `${ENVELOPE_START}<${method} xmlns="urn:vim25">${morefXml('_this', self)}${params}</${method}>${ENVELOPE_END}`;
}

/** The SOAP fault type of a fault element: `InvalidLogin`, `NoPermission`... or null. */
function faultType(fault) {
  const detail = childOf(fault, 'detail');
  const first = elementsOf(detail)[0];
  const named = first?.attrs?.type || first?.name || '';
  const local = named.slice(named.indexOf(':') + 1).replace(/Fault$/, '');
  return /^[A-Za-z]{1,60}$/.test(local) ? local : null;
}

/**
 * The body of a SOAP answer: the element `<Method>Response`, its `returnval`
 * children, or a VsphereError for a fault (its type only, never its text).
 * `status`: the HTTP status (200, or 500 for a fault).
 */
export function readAnswer(buffer, status) {
  let root;
  try {
    // An answer cut short (the connection dropped) is never taken as complete.
    root = parseXml(buffer.toString('utf8'), { complete: true });
  } catch (err) {
    if (err instanceof XmlError) {
      throw new VsphereError(
        status >= 500 ? CODES.HTTP : CODES.BAD_ANSWER,
        status >= 500 ? `HTTP ${status}` : 'Not XML',
        { status },
      );
    }
    throw err;
  }
  const body = root.name === 'Envelope' ? childOf(root, 'Body') : null;
  if (!body) {
    // A 5xx of a proxy (an HTML page) is a server error; a 200 that is not
    // SOAP is not vSphere.
    if (status >= 500) throw new VsphereError(CODES.HTTP, `HTTP ${status}`, { status });
    throw new VsphereError(CODES.BAD_ANSWER, 'Not a SOAP answer', { status });
  }
  const fault = childOf(body, 'Fault');
  if (fault) {
    const type = faultType(fault);
    // Own keys only: a type named `constructor` or `toString` is just a fault.
    const code = type && Object.hasOwn(FAULT_CODES, type) ? FAULT_CODES[type] : CODES.FAULT;
    throw new VsphereError(code, `SOAP fault ${type ?? 'unknown'}`, {
      status,
      fault: type ?? 'unknown',
    });
  }
  if (status !== 200) throw new VsphereError(CODES.HTTP, `HTTP ${status}`, { status });
  const response = elementsOf(body)[0];
  if (!response || !response.name.endsWith('Response')) {
    throw new VsphereError(CODES.BAD_ANSWER, 'Not a SOAP answer', { status });
  }
  return response;
}

/** The first `returnval` of a response element (or undefined: void, or nothing found). */
export const returnval = (response) => childOf(response, 'returnval');

/**
 * A property value of RetrievePropertiesEx (`<val xsi:type="...">`): a
 * number for the xsd integer types, a boolean, a string (enums too), a
 * moref { type, value }, or null when it is something else (a structure).
 */
export function valueOf(val) {
  if (!val) return null;
  const type = (val.attrs?.type ?? '').replace(/^xsd:/, '');
  const raw = textOf(val).trim();
  switch (type) {
    case 'int':
    case 'long':
    case 'short':
    case 'byte':
      return /^-?\d{1,18}$/.test(raw) ? Number(raw) : null;
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : null;
    case 'string':
      return raw;
    case 'ManagedObjectReference':
      // Its own `type` attribute shares the name of xsi:type (the first one
      // is kept): the value is enough, the path says what it points to.
      return raw;
    default:
      // An enum (HostSystemPowerState, VirtualMachinePowerState...) is a
      // plain text with its own xsi:type; a structure has child elements.
      return elementsOf(val).length === 0 ? raw : null;
  }
}

/**
 * The objects of a RetrievePropertiesEx / ContinueRetrievePropertiesEx answer:
 * { token, objects: [{ type, id, props: Map(name -> value), missing: Set }] }.
 */
export function readObjects(response) {
  const result = returnval(response);
  if (!result) return { token: null, objects: [] };
  const token = childOf(result, 'token');
  const objects = [];
  for (const node of elementsOf(result)) {
    if (node.name !== 'objects') continue;
    const obj = childOf(node, 'obj');
    if (!obj) continue;
    const props = new Map();
    const missing = new Set();
    for (const child of elementsOf(node)) {
      if (child.name === 'propSet') {
        const name = textOf(childOf(child, 'name')).trim();
        if (name && !props.has(name)) props.set(name, valueOf(childOf(child, 'val')));
      } else if (child.name === 'missingSet') {
        const path = textOf(childOf(child, 'path')).trim();
        if (path) missing.add(path);
      }
    }
    objects.push({ type: obj.attrs.type ?? '', id: textOf(obj).trim(), props, missing });
  }
  return { token: token ? textOf(token).trim() || null : null, objects };
}
