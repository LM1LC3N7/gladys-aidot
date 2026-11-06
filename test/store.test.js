// -----------------------------------------------------------------------------
// /data: the file read back strictly, bounded; a special file refused; the
// temporary folders of the tests removed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory } from '../src/store.js';

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'aidot-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const NOW = Date.UTC(2026, 9, 31, 12);

test('saved and read back; the file is 0600; no file is null', async (t) => {
  const dir = await folder(t);
  const store = fileStore(join(dir, 's.json'));
  assert.equal(await store.load(), null);
  const memory = {
    format: 1,
    salt: 'a'.repeat(32),
    terminal: 'b'.repeat(32),
    refused: { account: 'c'.repeat(16), mark: 5 },
    lastCloudAt: NOW,
    guards: [{ id: 'u-1', left: true, tries: 1, accepted: true }],
  };
  await store.save(memory);
  assert.deepEqual(await store.load(), memory);
  assert.equal((await stat(join(dir, 's.json'))).mode & 0o777, 0o600);
});

test('a FIFO, a link, a folder, a large or broken file: unreadable (throws), never a wait', async (t) => {
  const dir = await folder(t);
  const fifo = join(dir, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(fileStore(fifo).load(), /not a plain file/);
  await writeFile(join(dir, 'real.json'), '{}');
  await symlink(join(dir, 'real.json'), join(dir, 'link.json'));
  await assert.rejects(fileStore(join(dir, 'link.json')).load(), /not a plain file/);
  await assert.rejects(fileStore(dir).load(), /not a plain file/);
  await writeFile(join(dir, 'big.json'), ' '.repeat(200 * 1024));
  await assert.rejects(fileStore(join(dir, 'big.json')).load(), /too large/);
  await writeFile(join(dir, 'broken.json'), '{');
  await assert.rejects(fileStore(join(dir, 'broken.json')).load());
});

test('normalizeMemory: only valid entries; a future date dropped; tries unreadable = 0', () => {
  const memory = normalizeMemory(
    {
      salt: 'A'.repeat(32),
      terminal: 'b'.repeat(32),
      refused: { account: 'c'.repeat(16), mark: 64 },
      lastCloudAt: NOW + 60_000,
      pause: { until: NOW + 7 * 3600 * 1000, step: 3 },
      guards: [
        { id: 'u-1', left: 'yes', tries: 'x', accepted: true },
        { id: 'u-1', left: true, tries: 2 },
        { id: 'a:b', left: true },
        { id: 'u-2', left: true, tries: 500, accepted: true },
        'garbage',
      ],
    },
    NOW,
  );
  assert.equal(memory.salt, undefined, 'not lower-case hex');
  assert.equal(memory.terminal, 'b'.repeat(32));
  assert.equal(memory.refused, undefined, 'a mark of 6 bits at most, and a salt');
  assert.equal(memory.lastCloudAt, undefined, 'future: dropped');
  assert.equal(memory.pause, undefined, 'a pause beyond 6 h: dropped');
  assert.deepEqual(memory.guards, [
    { id: 'u-1', left: false, tries: 0, accepted: false },
    { id: 'u-2', left: true, tries: 99, accepted: true },
  ]);
  const ok = normalizeMemory(
    {
      salt: 'a'.repeat(32),
      refused: { account: 'c'.repeat(16), mark: 63, password: 'x' },
      pause: { until: NOW + 3600 * 1000, step: 2 },
      lastCloudAt: NOW - 5,
    },
    NOW,
  );
  assert.deepEqual(ok.refused, { account: 'c'.repeat(16), mark: 63 });
  assert.deepEqual(ok.pause, { until: NOW + 3600 * 1000, step: 2 });
  assert.equal(ok.lastCloudAt, NOW - 5);
  assert.deepEqual(normalizeMemory({ pause: { until: NOW - 5, step: 2 } }, NOW).pause, {
    until: undefined,
    step: 2,
  });
  assert.deepEqual(normalizeMemory('garbage', NOW).guards, []);
  assert.equal(
    normalizeMemory({ guards: Array(500).fill({ id: 'x', left: true }) }, NOW).guards.length,
    1,
  );
});

test('a save that hangs never blocks the next one (its own temporary file)', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 's.json');
  let hang = true;
  const fs = await import('node:fs/promises');
  const slow = {
    ...fs,
    open: async (...args) => {
      if (hang) {
        hang = false;
        return new Promise(() => {});
      }
      return fs.open(...args);
    },
  };
  const store = fileStore(path, { fs: slow, queueWait: 20 });
  store.save({ n: 1 });
  await store.save({ n: 2 });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 2 });
});

test('m2: a FIFO or a link left as the temporary file never blocks nor redirects a save', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 's.json');
  execFileSync('mkfifo', [`${path}.tmp`]);
  const store = fileStore(path);
  await store.save({ n: 1 });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 1 });
  await writeFile(join(dir, 'victim'), 'keep');
  await symlink(join(dir, 'victim'), `${path}.tmp`);
  await store.save({ n: 2 });
  assert.equal(await readFile(join(dir, 'victim'), 'utf8'), 'keep');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 2 });
});

test('m2: an older save that ends after a newer one never puts its state back', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 's.json');
  const fs = await import('node:fs/promises');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  const slow = {
    ...fs,
    open: async (...args) => {
      const file = await fs.open(...args);
      if (!first) return file;
      first = false;
      return {
        ...file,
        writeFile: async (...w) => {
          await gate;
          return file.writeFile(...w);
        },
        sync: () => file.sync(),
        close: () => file.close(),
      };
    },
  };
  const store = fileStore(path, { fs: slow, queueWait: 20 });
  const old = store.save({ n: 1 });
  await store.save({ n: 2 });
  await store.save({ n: 3 });
  release();
  await old;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 3 });
});
