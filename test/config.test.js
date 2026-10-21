// -----------------------------------------------------------------------------
// The configuration: the address (pasted from a browser too), the port, the
// fingerprint, the account, the options (all off by default).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseFingerprint, parseHost } from '../src/config.js';

test('the address: IP, name, IPv6, a port, a URL pasted from the browser', () => {
  assert.deepEqual(parseHost('192.168.1.10'), { host: '192.168.1.10', port: null });
  assert.deepEqual(parseHost(' ESXi01.LAN. '), { host: 'esxi01.lan', port: null });
  assert.deepEqual(parseHost('[fe80::1]:8443'), { host: 'fe80::1', port: 8443 });
  assert.deepEqual(parseHost('https://192.168.1.10/ui/'), { host: '192.168.1.10', port: null });
  assert.deepEqual(parseHost('https://vcenter.lan:8443/sdk'), { host: 'vcenter.lan', port: 8443 });
  for (const bad of [
    'http://192.168.1.10',
    'https://user:pass@192.168.1.10',
    'https://192.168.1.10/other',
    'https://192.168.1.10/?a=1',
    '300.1.1.1',
    'host:99999',
    'a b',
  ]) {
    assert.deepEqual(parseHost(bad), { error: 'invalid' }, bad);
  }
  assert.deepEqual(parseHost(''), { error: 'missing' });
});

test('the fingerprint: any usual form, or empty', () => {
  const hex = 'ab'.repeat(32);
  const pin = 'AB:'.repeat(31) + 'AB';
  assert.deepEqual(parseFingerprint(hex), { pin });
  assert.deepEqual(parseFingerprint(pin.toLowerCase()), { pin });
  assert.deepEqual(parseFingerprint(`SHA256: ${hex.match(/../g).join(' ')}`), { pin });
  assert.deepEqual(parseFingerprint(''), { pin: null });
  assert.deepEqual(parseFingerprint('ab:cd'), { error: 'invalid' });
  assert.deepEqual(parseFingerprint('zz'.repeat(32)), { error: 'invalid' });
});

test('defaults: port 443, every VM action off; booleans strictly true', () => {
  const config = normalizeConfig({ host: '192.168.1.10', username: 'gladys', password: ' p ' });
  assert.equal(config.port, 443);
  assert.equal(config.pollSeconds, 60);
  assert.equal(config.password, ' p ', 'never trimmed');
  assert.equal(config.allowStart, false);
  assert.equal(config.allowShutdown, false);
  assert.equal(config.allowRestart, false);
  const on = normalizeConfig({
    allow_vm_start: 'true',
    allow_vm_shutdown: 1,
    allow_vm_restart: true,
    poll_interval: '30',
  });
  assert.equal(on.allowStart, true);
  assert.equal(on.allowShutdown, false, 'only true or "true"');
  assert.equal(on.allowRestart, true);
  assert.equal(on.pollSeconds, 60, 'not a listed interval: the default');
  assert.equal(normalizeConfig({ password: 'a\nb' }).passwordInvalid, true);
  assert.equal(normalizeConfig({ username: 'a b' }).usernameInvalid, true);
  assert.equal(normalizeConfig({ port: 'abc' }).portInvalid, true);
  assert.equal(normalizeConfig({ certificate_fingerprint: 'xx' }).pinInvalid, true);
});
