// -----------------------------------------------------------------------------
// The transport (src/vsphere/http.js) and the client against REAL loopback
// HTTPS servers with self-signed certificates: the certificate learned by a
// request without a secret, the password sent only on a connection whose
// certificate matched the pin, an impostor receiving nothing, the size cap,
// the deadline, no redirect followed.
// -----------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { VsphereClient } from '../src/vsphere/client.js';
import { CODES } from '../src/vsphere/errors.js';
import { httpRequest } from '../src/vsphere/http.js';
import { PASSWORD, USERNAME, createFakeVsphere } from './helpers/fakeVsphere.js';
import { selfSigned } from './helpers/selfSigned.js';

const CERT = selfSigned();
const OTHER = selfSigned('impostor.lan');
const received = [];
let routes = {};
const fake = createFakeVsphere();

function handler(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    received.push({ server: req.socket.localPort, url: req.url, headers: req.headers, body });
    const route = routes[req.url];
    if (route?.hang) return;
    if (route) {
      res.writeHead(route.status, route.headers ?? { 'content-type': 'text/xml' });
      res.end(route.body);
      return;
    }
    const answer = fake.answer(body, req.headers);
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
}

const servers = {};
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
before(async () => {
  servers.real = https.createServer({ key: CERT.key, cert: CERT.cert }, handler);
  servers.other = https.createServer({ key: OTHER.key, cert: OTHER.cert }, handler);
  servers.ports = { real: await listen(servers.real), other: await listen(servers.other) };
});
after(async () => {
  for (const server of [servers.real, servers.other]) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

const OPTIONS = { timeout: 3_000, maxBytes: 64 * 1024 };
const target = (which = 'real', path = '/sdk') => ({
  host: '127.0.0.1',
  port: servers.ports[which],
  path,
});
const ENVELOPE = '<x/>';

test('a self-signed certificate is accepted on first use (no secret) and its fingerprint given', async () => {
  routes = { '/plain': { status: 200, body: 'ok' } };
  const response = await httpRequest(target('real', '/plain'), { ...OPTIONS, body: ENVELOPE });
  assert.equal(response.status, 200);
  assert.equal(response.fingerprint, CERT.fingerprint256);
  const pinned = await httpRequest(target('real', '/plain'), {
    ...OPTIONS,
    body: ENVELOPE,
    pin: CERT.fingerprint256,
    secret: true,
  });
  assert.equal(pinned.status, 200);
});

test('a secret is never sent without a pin, nor to another certificate', async () => {
  received.length = 0;
  routes = {};
  await assert.rejects(
    httpRequest(target(), { ...OPTIONS, body: PASSWORD, secret: true }),
    (err) => err.code === CODES.NO_PIN && err.notSent,
  );
  await assert.rejects(
    httpRequest(target('other'), {
      ...OPTIONS,
      body: PASSWORD,
      secret: true,
      pin: CERT.fingerprint256,
    }),
    (err) =>
      err.code === CODES.CERTIFICATE && err.notSent && err.fingerprint === OTHER.fingerprint256,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 0, 'nothing reached a server');
});

test('beforeSend: what it throws stops the request unsent', async () => {
  received.length = 0;
  await assert.rejects(
    httpRequest(target(), {
      ...OPTIONS,
      body: ENVELOPE,
      pin: CERT.fingerprint256,
      beforeSend: () => {
        throw new Error('option off');
      },
    }),
    (err) => err.message === 'option off' && err.notSent && err.beforeSend,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 0);
});

test('no redirect followed; a size cap; a deadline; a closed port', async () => {
  routes = {
    '/redirect': { status: 302, headers: { location: 'https://example.invalid/' }, body: '' },
    '/big': { status: 200, body: 'x'.repeat(70 * 1024) },
    '/hang': { hang: true },
  };
  const redirect = await httpRequest(target('real', '/redirect'), { ...OPTIONS, body: ENVELOPE });
  assert.equal(redirect.status, 302);
  await assert.rejects(
    httpRequest(target('real', '/big'), { ...OPTIONS, body: ENVELOPE }),
    (err) => err.code === CODES.TOO_LARGE,
  );
  await assert.rejects(
    httpRequest(target('real', '/hang'), { ...OPTIONS, body: ENVELOPE, timeout: 200 }),
    (err) => err.code === CODES.TIMEOUT && !err.notSent,
  );
  await assert.rejects(
    httpRequest({ ...target(), port: 1 }, { ...OPTIONS, body: ENVELOPE }),
    (err) => err.code === CODES.UNREACHABLE && err.notSent && !err.message.includes('127.0.0.1'),
  );
  routes = {};
});

test('the client: the certificate learned without a secret, then the login on the pinned connection', async () => {
  received.length = 0;
  const learned = [];
  const client = new VsphereClient({
    host: '127.0.0.1',
    port: servers.ports.real,
    username: USERNAME,
    password: PASSWORD,
    onPin: async (fp) => learned.push(fp),
  });
  const { objects, about } = await client.inventory(Date.now() + 10_000);
  assert.equal(about.apiType, 'HostAgent');
  assert.equal(objects.length, 4);
  assert.deepEqual(learned, [CERT.fingerprint256]);
  const methods = received.map((r) => /<([A-Za-z_]+) xmlns="urn:vim25">/.exec(r.body)[1]);
  assert.deepEqual(methods, ['RetrieveServiceContent', 'Login', 'RetrievePropertiesEx']);
  assert.ok(!received[0].body.includes(PASSWORD), 'no secret on the first, unpinned, request');
  assert.ok(received[1].body.includes('<password>fake Esxi pass-0123</password>'));
  assert.equal(received[0].headers.soapaction, 'urn:vim25/6.5');
  assert.match(received[2].headers.cookie, /^vmware_soap_session="fakeSessionCookie\d+abc"$/);
});

test('the client: an impostor at the address never receives the password', async () => {
  received.length = 0;
  const client = new VsphereClient({
    host: '127.0.0.1',
    port: servers.ports.other,
    username: USERNAME,
    password: PASSWORD,
    pin: CERT.fingerprint256,
  });
  await assert.rejects(
    client.inventory(Date.now() + 10_000),
    (err) => err.code === CODES.CERTIFICATE,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 0);
});
