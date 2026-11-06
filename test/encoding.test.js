// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, and never
// mojibake: UTF-8 bytes read as Latin-1 / Windows-1252 and saved again ("é"
// becoming "Ã©", "œ" becoming "Å“", the apostrophe "’" becoming "â€™").
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const MOJIBAKE = /Ã|Â|â€|Å[’“]/;
/** C1 control characters: what an upper-case accented letter leaves when read as Latin-1. */
const C1 = /[\u0080-\u009f]/;
/** C0 control characters (but tab, CR, LF): a lost escape. */
// eslint-disable-next-line no-control-regex
const C0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const root = new URL('../', import.meta.url);
const sources = (dir) =>
  readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(`${dir}${entry.name}/`)
      : entry.name.endsWith('.js')
        ? [`${dir}${entry.name}`]
        : [],
  );

const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'TODO.md',
  'CLAUDE.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'LICENSE',
  'index.js',
  ...sources('src/'),
];

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake`, () => {
    const bytes = readFileSync(new URL(file, root));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes(String.fromCharCode(0xfffd)), 'invalid UTF-8');
    const lines = text.split('\n');
    const line = lines.findIndex((l) => MOJIBAKE.test(l) || C1.test(l) || C0.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}: ${lines[line]}`);
  });
}

test('the source list covers src/**/*.js', () => {
  assert.ok(FILES.includes('src/app.js') && FILES.includes('src/link.js'));
});

test('the mojibake pattern catches what it should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Ã‰tat', MOJIBAKE, 'É read as Windows-1252');
  assert.match('Ã\u0089tat', MOJIBAKE, 'É read as Latin-1');
  assert.match('\u0089', C1);
  assert.match('Â°C', MOJIBAKE, '° read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.match('nÅ“ud', MOJIBAKE, 'œ read as Windows-1252');
  assert.doesNotMatch('nœud « Découverte » État À 800×534 — l’app… m³ kΩ °C', MOJIBAKE);
  assert.doesNotMatch('nœud « Découverte » État À 800×534 — l’app… m³ kΩ °C', C1);
});
