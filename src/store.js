// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), bounded and checked when read back. Never the e-mail, the
// password, a token, the user id, the address or the key of a light:
//   - a random salt (made once) for the fingerprints below, and the random
//     terminal id this installation gives at sign-in;
//   - a refusal of the credentials: a salted fingerprint of the account
//     (e-mail and country) and a 6-bit mark of the refused password, so that
//     the same password is never posted again by itself;
//   - the pause asked by the cloud (429 / 5xx) and the time of the last read
//     of the cloud list (a restart never reads it sooner than a minute);
//   - the Offs to send again (guards): the light, whether it ever left, how
//     many times the light answered it, whether its last send was answered.
// A small JSON file, written through a temporary file and a rename, one save
// after the other (never stuck behind one that hangs), readable by the
// container user only (0600). Only a plain file is read (a FIFO would never
// end, a link points elsewhere). The app bounds every read and save of it
// (src/app.js). Taken from gladys-deako 0.1.1.
// -----------------------------------------------------------------------------

import * as fsPromises from 'node:fs/promises';
import { constants } from 'node:fs';
import { LIMITS, TIMINGS } from './constants.js';
import { isId } from './protocol.js';

export const STATE_FILE = '/data/aidot-state.json';
export const FORMAT = 1;
/** A larger file is not ours: refused (read bounded). */
const MAX_STATE_BYTES = 128 * 1024;

/**
 * The /data file. Saves go one after the other, but a save never waits more than
 * `queueWait` for the one before it (a frozen fsync, say): it then writes through a
 * temporary file of its own, and an older write that ends after a newer one is in place
 * drops its file instead of renaming it over the newer state. Taken from gladys-deako
 * 0.1.1; the read refuses what is not a plain file.
 */
export function fileStore(
  path = STATE_FILE,
  { fs = fsPromises, timers = globalThis, queueWait = TIMINGS.storeWait } = {},
) {
  let previous = Promise.resolve();
  let count = 0;
  let placed = 0;
  let sharedBusy = false;
  let renames = Promise.resolve();
  return {
    /** null when there is no file (a fresh install); throws when it cannot be read or parsed. */
    async load() {
      let stats;
      try {
        stats = await fs.lstat(path);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      if (!stats.isFile()) throw Object.assign(new Error('not a plain file'), { code: 'EFTYPE' });
      if (stats.size > MAX_STATE_BYTES) throw new Error('state file too large');
      // Opened without blocking (a FIFO put there meanwhile would hold the open), checked again.
      const file = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const again = await file.stat();
        if (!again.isFile()) throw Object.assign(new Error('not a plain file'), { code: 'EFTYPE' });
        if (again.size > MAX_STATE_BYTES) throw new Error('state file too large');
        const text = await file.readFile('utf8');
        if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error('state file too large');
        return JSON.parse(text);
      } finally {
        await file.close();
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const seq = ++count;
      const before = previous;
      const write = (async () => {
        let timer;
        await Promise.race([
          before,
          new Promise((resolve) => {
            timer = timers.setTimeout(resolve, queueWait);
          }),
        ]);
        timers.clearTimeout(timer);
        const shared = !sharedBusy;
        if (shared) sharedBusy = true;
        const temporary = shared ? `${path}.tmp` : `${path}.tmp-${seq}`;
        try {
          const file = await openTemporary(fs, temporary);
          try {
            await file.writeFile(text, 'utf8');
            await file.sync();
          } finally {
            await file.close();
          }
          // The renames one after the other, in order: an older write never lands after a newer
          // one is in place (it drops its file instead).
          const step = renames.then(async () => {
            if (seq < placed) {
              await fs.unlink(temporary).catch(() => {});
              return;
            }
            await fs.rename(temporary, path);
            placed = seq;
          });
          renames = step.catch(() => {});
          await step;
        } finally {
          if (shared) sharedBusy = false;
        }
      })();
      previous = write.catch(() => {});
      return write;
    },
  };
}

/**
 * The temporary file, created anew: never through a link, never blocking on a FIFO or a
 * device left there (O_EXCL | O_NOFOLLOW | O_NONBLOCK); whatever was there is removed first.
 */
async function openTemporary(fs, temporary) {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
  try {
    return await fs.open(temporary, flags, 0o600);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    await fs.unlink(temporary);
    return fs.open(temporary, flags, 0o600);
  }
}

/** The same in memory (tests). `fail`: the next saves throw; `unreadable`: load throws; `hang`: never answers. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    fail: false,
    unreadable: false,
    hang: false,
    hangLoad: false,
    async load() {
      if (this.hangLoad) return new Promise(() => {});
      if (this.unreadable) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

const time = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const hex = (value, length) =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value) ? value : undefined;

/** A guard read back; undefined when not valid. A count of tries that cannot be read is 0. */
function guardOf(raw) {
  if (!plain(raw) || !isId(raw.id)) return undefined;
  return {
    id: raw.id,
    // Unreadable: never left.
    left: raw.left === true,
    tries: Number.isInteger(raw.tries) ? Math.min(Math.max(raw.tries, 0), 99) : 0,
    // Answered before: judged by a read, not sent again at once.
    accepted: raw.accepted === true && raw.left === true,
  };
}

/** An empty memory (a new salt and terminal id are made by the app when missing). */
export const emptyMemory = () => ({
  format: FORMAT,
  salt: undefined,
  terminal: undefined,
  refused: undefined,
  pause: undefined,
  lastCloudAt: undefined,
  guards: [],
});

/**
 * The persisted state, repaired. A time in the future is invalid (dropped), so a clock set
 * back or a hand-edited file never stops the reads for good; a pause ends 6 h from now at most.
 */
export function normalizeMemory(raw, now = Date.now()) {
  const memory = emptyMemory();
  if (!plain(raw)) return memory;
  memory.salt = hex(raw.salt, 32);
  memory.terminal = hex(raw.terminal, 32);
  if (
    memory.salt &&
    plain(raw.refused) &&
    hex(raw.refused.account, 16) &&
    Number.isInteger(raw.refused.mark) &&
    raw.refused.mark >= 0 &&
    raw.refused.mark < 64
  ) {
    memory.refused = { account: raw.refused.account, mark: raw.refused.mark };
  }
  if (plain(raw.pause)) {
    const until = time(raw.pause.until);
    const step = Number.isInteger(raw.pause.step) ? Math.min(Math.max(raw.pause.step, 0), 20) : 0;
    if (until !== undefined && until > now && until <= now + TIMINGS.pauseMax) {
      memory.pause = { until, step };
    } else if (until !== undefined && until <= now) {
      // Over: the next one starts from where it was (doubled), not from scratch.
      memory.pause = { until: undefined, step };
    }
  }
  const last = time(raw.lastCloudAt);
  if (last !== undefined && last <= now) memory.lastCloudAt = last;
  if (Array.isArray(raw.guards)) {
    const seen = new Set();
    for (const entry of raw.guards.slice(0, LIMITS.guards)) {
      const guard = guardOf(entry);
      if (guard && !seen.has(guard.id)) {
        seen.add(guard.id);
        memory.guards.push(guard);
      }
    }
  }
  return memory;
}
