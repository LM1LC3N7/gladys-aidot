// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The supported
// options follow the rules of the core (its validator when a clone is at hand).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import { ACTIONS, CLOUD, POLL_INTERVAL } from '../src/constants.js';
import { COUNTRIES } from '../src/countries.js';
import { buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics, the same version everywhere (semver, never pinned), no keywords nor countries yet', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-aidot:${manifest.version}`);
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-aidot');
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^/, 'never pinned');
  assert.deepEqual(manifest.transports, ['local', 'cloud']);
  assert.deepEqual(manifest.network_discovery, [{ type: 'udp-active-broadcast', ports: [6666] }]);
  assert.deepEqual(manifest.categories, ['lighting']);
  assert.equal(manifest.keywords, undefined, 'keywords need gladys_version >= 5.3.0');
  assert.equal(manifest.countries, undefined, 'countries need gladys_version >= 5.3.0');
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const flat = read(`docs/${lang}.md`).replace(/\n>?\s*/g, ' ');
    assert.match(flat, /not affiliated with AiDot|sans lien avec AiDot/i);
    assert.match(
      flat,
      lang === 'en' ? /never tested with a real device/i : /jamais testé avec un vrai appareil/i,
    );
  }
  for (const file of [
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'docs/en.md',
    'docs/fr.md',
  ]) {
    assert.doesNotMatch(read(file), /encrypt|chiffr|hach/i, `${file}: nothing is encrypted`);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /encrypt|chiffr|hach/i);
  assert.match(read('TODO.md'), /## Decisions/);
  assert.match(read('TODO.md'), /0\.1\.0/);
  assert.match(read('CHANGELOG.md'), /## \[Unreleased\]/);
});

test('the licenses ship with the image; LICENSE is the standard text, without a name', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.doesNotMatch(license, /Louis|lmilcent|LM1LC3N7|Milcent/i);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Aidot-Development-Team\/python-aidot/);
  assert.match(notices, new RegExp(CLOUD.appId));
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(read('Dockerfile'), /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('the configuration matches the code; no secret, no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const key of Object.keys(fields)) assert.doesNotMatch(key, /^gladys_/i);
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.equal(fields.email.required, true);
  assert.equal(fields.email.default, undefined);
  assert.equal(fields.password.type, 'secret');
  assert.equal(fields.password.required, true);
  assert.equal(fields.password.default, undefined, 'no default for a secret');
  assert.deepEqual(
    manifest.config_schema.filter((f) => f.type === 'secret').map((f) => f.key),
    ['password'],
  );
  assert.deepEqual(
    fields.country.options.map((o) => o.value).sort(),
    COUNTRIES.map(([code]) => code).sort(),
  );
  for (const option of fields.country.options) {
    const [, name] = COUNTRIES.find(([code]) => code === option.value);
    assert.equal(option.label.en, name, 'the English name is the one the cloud expects');
  }
  for (const lang of ['en', 'fr']) {
    assert.match(fields.password.description[lang], /Gladys/);
    assert.match(fields.password.description[lang], /AiDot/);
  }
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max, fields.poll_interval.default],
    [POLL_INTERVAL.min, POLL_INTERVAL.max, POLL_INTERVAL.default],
  );
  for (const field of manifest.config_schema) {
    if (field.placeholder !== undefined)
      assert.equal(typeof field.placeholder, 'object', field.key);
    for (const option of field.options ?? []) {
      assert.equal(typeof option.value, 'string');
      for (const lang of ['en', 'fr']) assert.equal(typeof option.label[lang], 'string');
    }
  }
  for (const lang of ['en', 'fr']) {
    assert.ok(fields.intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
    assert.match(
      fields.intro.description[lang],
      /Never tested with a real device|Jamais testé avec un vrai appareil/,
    );
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});

// The core's own validator of supported_options, when a Gladys clone is at hand (not on
// GitHub CI); the rules below are its schema, copied so that the CI applies them too: a
// non-blank trimmed string label, an integer value, an integer sort_order, no other key, no
// two values alike. One error rejects the whole Discover list in the core.
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;
const OPTION_KEYS = ['id', 'value', 'label', 'sort_order'];
function checkOptions(options, where) {
  assert.ok(Array.isArray(options) && options.length > 0, `${where}: options`);
  for (const [i, option] of options.entries()) {
    const at = `${where}[${i}]`;
    assert.equal(typeof option.label, 'string', `${at}.label must be a string`);
    assert.ok(option.label.trim().length > 0, `${at}.label is blank`);
    assert.equal(option.label, option.label.trim(), `${at}.label has surrounding whitespace`);
    assert.ok(Number.isInteger(option.value), `${at}.value`);
    assert.deepEqual(
      Object.keys(option).filter((k) => !OPTION_KEYS.includes(k)),
      [],
      `${at}: key`,
    );
  }
  const values = options.map((o) => `${o.value}`);
  assert.equal(new Set(values).size, values.length, `${where}: duplicate values`);
  if (normalizeSupportedOptions)
    assert.doesNotThrow(() => normalizeSupportedOptions(options), where);
}

test('the option rules reject what the core rejects', () => {
  assert.throws(
    () => checkOptions([{ value: 0, label: { en: 'Off' } }], 'bad'),
    /label must be a string/,
  );
  assert.throws(() => checkOptions([{ value: 0, label: 'a ' }], 'bad'), /whitespace/);
  assert.throws(
    () =>
      checkOptions(
        [
          { value: 0, label: 'a' },
          { value: 0, label: 'b' },
        ],
        'bad',
      ),
    /duplicate/,
  );
  assert.throws(() => checkOptions([{ value: 0, label: 'a', x: 1 }], 'bad'), /key/);
});

test('the published features: light only, no unit (none listed by the core for light), never a switch', () => {
  const gladys = createFakeGladys({ selector: 'aidot' });
  const kinds = [
    [{ known: true, color: true, cct: { min: 2700, max: 6500 } }, 4],
    [{ known: true, color: false, cct: { min: 2200, max: 6500 } }, 3],
    [{ known: true, color: false, cct: undefined }, 2],
    [{ known: false, color: false, cct: undefined }, 2],
  ];
  for (const language of LANGUAGES) {
    for (const [caps, count] of kinds) {
      const device = buildDevice(gladys, { id: 'abc-1', name: 'x', caps }, { language });
      assert.equal(device.features.length, count);
      for (const f of device.features) {
        assert.equal(f.category, 'light');
        assert.equal(f.unit, undefined);
        assert.notEqual(f.category, 'switch');
        if (f.supported_options) checkOptions(f.supported_options, f.external_id);
        assert.equal(f.supported_options, undefined);
      }
    }
  }
});
