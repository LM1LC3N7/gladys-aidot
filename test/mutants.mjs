// -----------------------------------------------------------------------------
// The mutants of the guards, replayable: `node scripts/mutants.mjs` (one at a
// time on a copy, the process group killed at the deadline). Each must make a
// test fail; `equivalent` ones (no behaviour change) are listed with why, and
// skipped. A mutant is killed by a test, never by removing a guard.
// -----------------------------------------------------------------------------

const M = (file, from, to, name, equivalent) => ({ file, from, to, name, equivalent });
const L = 'src/link.js';
const A = 'src/app.js';
const C = 'src/cloud.js';
const P = 'src/protocol.js';

export const MUTANTS = [
  // --- The line of a light (src/link.js)
  M(
    L,
    'if (!this.queue.some((j) => j.priority === PRIORITY.PROTECTIVE)) return;',
    'return;',
    'link: an Off never cuts a silent request',
  ),
  M(
    L,
    'quietSince + TIMINGS.stuck - this.monotonic()',
    'quietSince + TIMINGS.stuck * 30 - this.monotonic()',
    'link: cut after 30 s',
  ),
  M(
    L,
    'if (message.deviceId !== undefined && message.deviceId !== this.light.id) {',
    'if (false) {',
    'link: another light accepted at login',
  ),
  M(L, 'if (message.code !== 200) {', 'if (false) {', 'link: a refused login taken as open'),
  M(P, 'if (size > maxBytes) throw', 'if (false) throw', 'protocol: no bound on a frame'),
  // --- Offs (src/app.js)
  M(A, 'deadline: Infinity,', 'deadline: this.monotonic() + 100,', 'off: a deadline to leave'),
  M(A, '    this.cancelCommands(id);\n', '\n', 'off: commands clicked before still leave'),
  M(A, '}, TIMINGS.guardProbe);', '}, TIMINGS.guardProbe * 100);', 'off: no resend every 10 s'),
  M(A, 'return guard.tries <= TIMINGS.resendMax;', 'return true;', 'off: resent for ever'),
  M(A, "this.endGuard(guard, 'on');", 'return;', 'off: undone after the switch'),
  M(A, 'guard.contradicted = true;', 'guard.contradicted = false;', 'off: never resent when on'),
  M(A, 'guard.okSeen = true;', 'guard.okSeen = false;', 'off: an answer never counted'),
  // --- Order and confirmation
  M(
    A,
    "if (kind === 'read' && !((at ?? 0) > entry.mark)) return;",
    '',
    'order: an old read applies after a command',
  ),
  M(
    A,
    '(entry.answered || !shows(entry.target, entry.before))',
    'true',
    'confirm: the state of before taken as a confirmation',
  ),
  M(A, 'entry.answered = true;', '', 'confirm: an answer of the light never counted'),
  // --- Bounds
  M(
    A,
    'target.cct >= range.min && target.cct <= range.max',
    'true',
    'bounds: a temperature out of the range sent',
  ),
  M(
    A,
    'if (light.caps.known && !light.caps.color) return ERRORS.notSupported;',
    '',
    'bounds: a colour sent to a white light',
  ),
  // --- The account
  M(
    A,
    'if (this.refusedNow() && !this.mayPost) return Infinity;',
    'if (false) return Infinity;',
    'account: a refused password posted again',
  ),
  M(A, 'this.memory.refused = {', 'this.memory.refusedX = {', 'account: the refusal not kept'),
  M(A, 'if (saved) this.mayPost = true;', '', 'account: new credentials not tried after a refusal'),
  M(
    C,
    "throw new CloudError(status === 401 || status === 403 ? 'denied' : 'session', {",
    "throw new CloudError('refused', {",
    'account: a 401 of a read taken for a refusal',
  ),
  M(
    A,
    'at = Math.max(at, this.lastCloudAt + TIMINGS.cloudGap);',
    'at = Math.max(at, this.lastCloudAt);',
    'cloud: no minute between two reads',
  ),
  M(A, 'if (this.paused(mono)) at = Math.max(at, this.pauseUntil);', '', 'cloud: no pause'),
  M(
    A,
    'this.memory.pause = { until: now + (this.pauseUntil - mono), step: this.pauseStep };',
    'this.memory.pause = undefined;',
    'cloud: the pause lost at a restart',
  ),
  M(
    A,
    'this.configTries += 1;',
    'this.configTries += 1;\n      return;',
    'config: never read again',
  ),
  // --- Discovery
  M(
    A,
    'if (parsed.mac && entry.light.mac && parsed.mac !== entry.light.mac) continue;',
    '',
    'discovery: another MAC taken',
  ),
  M(
    A,
    'const ip = lanAddress(reply?.source_ip);',
    'const ip = reply?.source_ip;',
    'discovery: an address outside the network taken',
  ),
  M(
    A,
    'const other = entry.lastState && !shows(entry.target, entry.lastState);',
    'const other = entry.lastState;',
    'confirm: a state showing the target said "another state"',
  ),
];
