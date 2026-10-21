// -----------------------------------------------------------------------------
// The XML parser, the SOAP envelopes and answers, and the parsing of the
// properties: hostile answers stay bounded and linear, faults are told apart
// by their type only, values out of bounds are unknown (never 0).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sessionCookie } from '../src/vsphere/client.js';
import { CODES } from '../src/vsphere/errors.js';
import { parseInventory, parseVm, parseVmCheck } from '../src/vsphere/parse.js';
import { envelope, moref, readAnswer, readObjects, valueOf } from '../src/vsphere/soap.js';
import {
  XmlError,
  childOf,
  decodeEntities,
  escapeXml,
  parseXml,
  textOf,
} from '../src/vsphere/xml.js';
import { faultXml } from './helpers/fakeVsphere.js';

const answer = (inner) =>
  Buffer.from(
    `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`,
  );

test('an envelope: the method in urn:vim25, _this first, values escaped', () => {
  const xml = envelope(
    'Login',
    moref('SessionManager', 'ha-sessionmgr'),
    '<userName>a&amp;b</userName>',
  );
  assert.match(
    xml,
    /<Login xmlns="urn:vim25"><_this type="SessionManager">ha-sessionmgr<\/_this><userName>/,
  );
  assert.equal(escapeXml(`<p>&"'`), '&lt;p&gt;&amp;&quot;&apos;');
});

test('XML: a DOCTYPE is refused, depth and size bounded, entities decoded linearly', () => {
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>'), XmlError);
  assert.throws(() => parseXml('<a>'.repeat(100)), XmlError);
  assert.throws(() => parseXml('x'.repeat(9 * 1024 * 1024)), XmlError);
  assert.equal(decodeEntities('&lt;&#65;&#x42;&bogus;&'), '<AB&bogus;&');
  const many = '&'.repeat(200_000);
  const started = Date.now();
  assert.equal(decodeEntities(many).length, 200_000);
  assert.ok(Date.now() - started < 1000, 'linear');
  // Many text pieces in one element: joined once.
  const pieces = `<a>${'x<!---->'.repeat(50_000)}</a>`;
  const t0 = Date.now();
  assert.equal(textOf(parseXml(pieces)).length, 50_000);
  assert.ok(Date.now() - t0 < 2000);
  // No prototype pollution through attributes.
  const el = parseXml('<a __proto__="x" constructor="y"/>');
  assert.equal(Object.getPrototypeOf(el.attrs), null);
  assert.equal({}.x, undefined);
});

test('answers: a fault by its type only (never its text), a proxy 5xx, not SOAP', () => {
  for (const [type, code] of [
    ['InvalidLogin', CODES.CREDENTIALS],
    ['NotAuthenticated', CODES.SESSION],
    ['NoPermission', CODES.ACCESS],
    ['ManagedObjectNotFound', CODES.NOT_FOUND],
    ['RestrictedVersion', CODES.RESTRICTED],
    ['InvalidPowerState', CODES.FAULT],
  ]) {
    assert.throws(
      () => readAnswer(Buffer.from(faultXml(type, 'secret name vm-01')), 500),
      (err) => err.code === code && err.fault === type && !err.message.includes('secret'),
    );
  }
  assert.throws(
    () => readAnswer(Buffer.from('<html>Bad gateway</html>'), 500),
    (err) => err.code === CODES.HTTP && err.status === 500,
  );
  assert.throws(
    () => readAnswer(Buffer.from('{"a":1}'), 200),
    (err) => err.code === CODES.BAD_ANSWER,
  );
  const ok = readAnswer(answer('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'), 200);
  assert.equal(ok.name, 'LogoutResponse');
});

test('property values: numbers, booleans, enums, morefs; structures and junk are null', () => {
  const val = (xml) => valueOf(parseXml(xml));
  assert.equal(val('<val xsi:type="xsd:int">42</val>'), 42);
  assert.equal(val('<val xsi:type="xsd:long">-7</val>'), -7);
  assert.equal(val('<val xsi:type="xsd:int">4e5</val>'), null);
  assert.equal(val('<val xsi:type="xsd:boolean">true</val>'), true);
  assert.equal(val('<val xsi:type="xsd:boolean">yes</val>'), null);
  assert.equal(val('<val xsi:type="VirtualMachinePowerState">poweredOn</val>'), 'poweredOn');
  assert.equal(
    val('<val xsi:type="ManagedObjectReference" type="HostSystem">host-12</val>'),
    'host-12',
  );
  assert.equal(val('<val xsi:type="GuestInfo"><ipAddress>1.2.3.4</ipAddress></val>'), null);
});

test('objects of RetrievePropertiesEx: token, props, missing; the inventory bounded and cleaned', () => {
  const response = readAnswer(
    answer(
      `<RetrievePropertiesExResponse xmlns="urn:vim25"><returnval><token>t1</token>` +
        `<objects><obj type="VirtualMachine">vm-1</obj>` +
        `<propSet><name>name</name><val xsi:type="xsd:string">web\u0007 server</val></propSet>` +
        `<propSet><name>config.instanceUuid</name><val xsi:type="xsd:string">5012A3B4-C5D6-47E8-9F01-23456789ABCD</val></propSet>` +
        `<propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOn</val></propSet>` +
        `<propSet><name>summary.config.numCpu</name><val xsi:type="xsd:int">-3</val></propSet>` +
        `<missingSet><path>guest.toolsRunningStatus</path></missingSet></objects>` +
        `<objects><obj type="VirtualMachine">vm-2</obj>` +
        `<propSet><name>config.instanceUuid</name><val xsi:type="xsd:string">5012a3b4-c5d6-47e8-9f01-23456789abcd</val></propSet></objects>` +
        `<objects><obj type="VirtualMachine">vm-3</obj>` +
        `<propSet><name>config.instanceUuid</name><val xsi:type="xsd:string">50000000-0000-4000-8000-000000000001</val></propSet>` +
        `<propSet><name>config.template</name><val xsi:type="xsd:boolean">true</val></propSet></objects>` +
        `<objects><obj type="HostSystem">Bad Moref!</obj></objects>` +
        `</returnval></RetrievePropertiesExResponse>`,
    ),
    200,
  );
  const { token, objects } = readObjects(response);
  assert.equal(token, 't1');
  assert.equal(objects.length, 4);
  assert.ok(objects[0].missing.has('guest.toolsRunningStatus'));
  const vm = parseVm(objects[0]);
  assert.equal(vm.uuid, '5012a3b4-c5d6-47e8-9f01-23456789abcd');
  assert.equal(vm.name, 'web server');
  assert.equal(vm.cpus, null, 'out of bounds: unknown');
  assert.equal(vm.tools, null);
  const inv = parseInventory(objects);
  assert.equal(inv.vms.length, 1, 'the copy with the same UUID and the template are left out');
  assert.equal(inv.hosts.length, 0);
  assert.equal(inv.skipped, 3);
  const check = parseVmCheck({ props: new Map([['config.instanceUuid', 'garbage']]) });
  assert.equal(check.uuid, null, 'unreadable, not another VM');
});

test('the session cookie of a Set-Cookie header, nothing else', () => {
  assert.equal(
    sessionCookie(['vmware_soap_session="52abc"; Path=/; HttpOnly; Secure;']),
    'vmware_soap_session="52abc"',
  );
  assert.equal(
    sessionCookie('other=1, vmware_soap_session=52def; Path=/'),
    'vmware_soap_session=52def',
  );
  assert.equal(sessionCookie(['vmware_soap_session=bad value']), 'vmware_soap_session=bad');
  assert.equal(sessionCookie(undefined), null);
  assert.equal(sessionCookie(['nothing=here']), null);
});

test('the source never calls a host action, a power off nor a reset', () => {
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const text = readFileSync(new URL(file.replaceAll('\\', '/'), dir), 'utf8');
    for (const forbidden of [
      'ShutdownHost',
      'RebootHost',
      'PowerDownHostToStandBy',
      'EnterMaintenanceMode',
      'PowerOffVM',
      'ResetVM',
      'SuspendVM',
      'Destroy_Task',
      'UnregisterVM',
    ]) {
      assert.ok(!text.includes(forbidden), `${file} mentions ${forbidden}`);
    }
  }
  // The only actions the client accepts.
  const client = readFileSync(new URL('vsphere/client.js', dir), 'utf8');
  assert.match(client, /\['PowerOnVM_Task', 'ShutdownGuest', 'RebootGuest'\]\.includes\(method\)/);
  assert.equal(childOf(parseXml('<a><b/></a>'), 'b').name, 'b');
});
