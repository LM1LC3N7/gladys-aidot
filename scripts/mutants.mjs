// Replays the mutants of test/mutants.mjs, one at a time, on a copy of the repository in a
// temporary folder of its own (removed at the end); the whole process group of a run is killed
// after 150 s, so a mutant that makes a test hang is reported, never waited for.
// Usage: node scripts/mutants.mjs [first] [last]   (run it under memcap on the dev VM)
import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from '../test/mutants.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const first = Number(process.argv[2] ?? 0);
const last = Number(process.argv[3] ?? MUTANTS.length - 1);
const work = mkdtempSync(join(tmpdir(), 'aidot-mutants-'));
cpSync(REPO, work, {
  recursive: true,
  filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
});
// Only to run node --test in the copy (never npm ci there).
symlinkSync(join(REPO, 'node_modules'), join(work, 'node_modules'));
const tests = readdirSync(join(work, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => `test/${f}`);

function run() {
  return new Promise((resolve) => {
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    void NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-timeout=30000', ...tests], {
      cwd: work,
      env,
      detached: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      resolve('HUNG');
    }, 150_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const survivors = [];
try {
  if ((await run()) !== 0) throw new Error('the tests fail without any mutant');
  for (let i = first; i <= last && i < MUTANTS.length; i += 1) {
    const m = MUTANTS[i];
    if (m.equivalent) {
      console.log(`#${i} equivalent  ${m.name} (${m.equivalent})`);
      continue;
    }
    const path = join(work, m.file);
    const original = readFileSync(path, 'utf8');
    const n = original.split(m.from).length - 1;
    if (n !== 1) {
      console.log(`#${i} INVALID (${n} matches)  ${m.name}`);
      survivors.push(`#${i} INVALID ${m.name}`);
      continue;
    }
    writeFileSync(
      path,
      original.replace(m.from, () => m.to),
    );
    const started = Date.now();
    const code = await run();
    writeFileSync(path, original);
    const verdict = code === 0 ? 'SURVIVED' : code === 'HUNG' ? 'HUNG' : 'killed';
    if (code === 0 || code === 'HUNG') survivors.push(`#${i} ${verdict} ${m.name}`);
    console.log(`#${i} ${verdict} ${Math.round((Date.now() - started) / 1000)}s  ${m.name}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(survivors.length ? `NOT KILLED:\n${survivors.join('\n')}` : 'ALL KILLED');
process.exitCode = survivors.length ? 1 : 0;
