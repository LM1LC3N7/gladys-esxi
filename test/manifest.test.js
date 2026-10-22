// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS } from '../src/config.js';
import { ACTIONS, FEATURES, POLL_INTERVALS, VM_ACTIONS } from '../src/constants.js';
import { buildDatastoreDevice, buildHostDevice, buildVmDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
const DOCS = () => [
  ['manifest', JSON.stringify(manifest)],
  ['docs/en.md', read('docs/en.md')],
  ['docs/fr.md', read('docs/fr.md')],
  ['README.md', read('README.md')],
  ['src/i18n.js', read('src/i18n.js')],
];

test('the store basics; version 0.1.0 set by hand everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-esxi:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-esxi');
  assert.equal(lock.name, 'gladys-esxi');
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-esxi/main/cover.png',
  );
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien/);
  assert.match(read('docs/en.md'), /never been tested with a real ESXi host/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai hôte ESXi/i);
});

test('the license (no personal name) and the notices ship in the image', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard text');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /pyVmomi/);
  assert.match(notices, /Copyright \(c\) 2005-2024 Broadcom/);
  assert.match(notices, /Apache License/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; the actions off; the secret never said encrypted', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.poll_interval.options.map((o) => o.value),
    POLL_INTERVALS,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'host',
    'port',
    'certificate_fingerprint',
    'username',
    'password',
    'poll_interval',
    'commands',
    'allow_vm_start',
    'allow_vm_shutdown',
    'allow_vm_restart',
  ]);
  assert.equal(fields.password.type, 'secret');
  assert.match(fields.password.description.en, /Kept by Gladys in its database, never shown again/);
  assert.match(fields.password.description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
  for (const key of ['allow_vm_start', 'allow_vm_shutdown', 'allow_vm_restart']) {
    assert.equal(fields[key].type, 'boolean');
    assert.equal(fields[key].default, false, `${key} is off by default`);
  }
  for (const [name, text] of DOCS()) {
    assert.doesNotMatch(text, /chiffr|encrypt/i, `${name}: a secret is not encrypted`);
  }
});

test('sections store nothing; links https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.equal(section.placeholder, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    for (const text of Object.values(section.description)) {
      assert.ok(text.length <= 1000, `${section.key}: ${text.length} characters`);
    }
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_actions, undefined, 'no scene action');
  assert.equal(manifest.scene_triggers, undefined, 'no scene trigger in v1');
  assert.equal(manifest.widgets, undefined, 'no widget in v1');
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(', "on('connected'"]) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('placeholders are multi-language objects', () => {
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
    assert.ok(field.placeholder.en && field.placeholder.fr, field.key);
  }
});

test('features: readings read only, the VM actions buttons, no switch, no host action; units of the core; keys fixed', () => {
  const gladys = createFakeGladys({ selector: 'esxi' });
  const host = buildHostDevice(gladys, { id: 'ha-host' });
  const datastore = buildDatastoreDevice(gladys, { id: 'datastore-15' });
  const vm = buildVmDevice(gladys, { uuid: '5012a3b4-c5d6-47e8-9f01-23456789abcd' });
  const features = [...host.features, ...datastore.features, ...vm.features];
  // Pairs and units of server/utils/constants.js of the core
  // (DEVICE_FEATURE_UNITS_BY_CATEGORY).
  const allowed = {
    unknown: { types: ['binary', 'unknown'], units: [undefined] },
    text: { types: ['text'], units: [undefined] },
    button: { types: ['push'], units: [undefined] },
    'counter-sensor': { types: ['integer'], units: [undefined] },
    duration: { types: ['decimal'], units: ['hours'] },
    data: { types: ['size'], units: ['megabyte', 'gigabyte'] },
  };
  for (const feature of features) {
    const rule = allowed[feature.category];
    assert.ok(
      rule?.types.includes(feature.type),
      `${feature.name}: ${feature.category}/${feature.type}`,
    );
    assert.ok(rule.units.includes(feature.unit), `${feature.name}: unit ${feature.unit}`);
    assert.notEqual(feature.category, 'switch');
    if (feature.category === 'button') assert.equal(feature.read_only, false);
    else assert.equal(feature.read_only, true, feature.name);
  }
  assert.ok(
    host.features.every((f) => f.category !== 'button'),
    'no host action',
  );
  assert.deepEqual(
    vm.features.filter((f) => f.category === 'button').map((f) => f.external_id.split(':').at(-1)),
    Object.keys(VM_ACTIONS),
  );
  assert.deepEqual(
    [...new Set(features.map((f) => f.external_id.split(':').at(-1)))].sort(),
    Object.values(FEATURES).sort(),
  );
  assert.equal(host.external_id, 'ext:esxi:host:ha-host', 'the external id shape is forever');
  assert.equal(datastore.external_id, 'ext:esxi:datastore:datastore-15');
  assert.equal(vm.external_id, 'ext:esxi:vm:5012a3b4-c5d6-47e8-9f01-23456789abcd');
});
