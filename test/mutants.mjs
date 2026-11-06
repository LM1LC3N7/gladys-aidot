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
const H = 'src/http.js';
const D = 'src/model.js';

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
  M(
    A,
    '    if (this.paused(mono)) {\n      at = Math.max(',
    '    if (false) {\n      at = Math.max(',
    'cloud: no pause',
  ),
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
  // --- Review r1 (the reviewer's survivors and the fixes)
  M(
    C,
    "if (status < 200 || status >= 300) throw new CloudError('http', { status, code });",
    "if (status < 200 || status >= 300) throw new CloudError('refused', { status, code });",
    'r1 I4#0: a sign-in 401 taken for a refusal',
  ),
  M(
    A,
    'return !guard.left || mono - guard.sentAt >= TIMINGS.guardProbe * 0.9;',
    'return !guard.left || mono - guard.sentAt >= TIMINGS.guardProbe * 6;',
    'r1 I4#1: an Off without answer resent every 60 s',
  ),
  M(
    A,
    'return guard.contradicted && mono - guard.sentAt >= TIMINGS.guardProbe * 0.9;',
    'return guard.contradicted && mono - guard.sentAt >= TIMINGS.guardProbe * 6;',
    'r1 M2: an Off contradicted resent every 60 s',
  ),
  M(
    A,
    'const wait = Math.min(Math.max(asked, TIMINGS.pauseMin), TIMINGS.pauseMax);',
    'const wait = Math.max(asked, TIMINGS.pauseMin);',
    'r1 I4#6: Retry-After not bounded',
  ),
  M(
    A,
    '      ...(g.okSeen ? { accepted: true } : {}),',
    '      ...(g.okSeen ? { accepted: true } : {}),\n      k: this.lights.get(g.id)?.light?.key?.toString(),',
    'r1 I4#15: the key of a light in /data',
  ),
  M(
    A,
    'const answerBy = received + TIMINGS.offAck;',
    'const answerBy = received + 6000;',
    'r1 I4#23: the ack of an Off after 6 s',
  ),
  M(
    A,
    'Math.max(0, received + TIMINGS.commandAck - this.monotonic())',
    'Math.max(0, received + 6000 - this.monotonic())',
    'r1 I4#22: the ack of a command after 6 s',
  ),
  M(
    A,
    "if (kind === 'answer' && !((at ?? 0) >= entry.mark)) return;",
    '',
    'r1 I4#3: an old answer applies after a newer command',
  ),
  M(
    A,
    'if (this.guards.get(id)?.userInFlight) throw this.refusal(ERRORS.stopPending);',
    '',
    'r1 I4#10: a command leaves during an Off click',
  ),
  M(
    H,
    '          if (size > maxBytes) {',
    '          if (false) {',
    'r1 I4#7: HTTP body not bounded',
  ),
  M(
    A,
    'refused.mark === passwordMarkOf(this.config.password, this.memory.salt)',
    'true',
    'r1 I4#20: another password of the account taken as refused',
  ),
  M(
    A,
    'needy ? Math.min(this.pauseUntil, last + TIMINGS.guardCloudPause) : this.pauseUntil,',
    'this.pauseUntil,',
    'r1 I1: an Off held waits for the whole pause',
  ),
  M(
    A,
    'needy ? Math.min(this.cloudRetryAt, last + TIMINGS.cloudGap) : this.cloudRetryAt,',
    'this.cloudRetryAt,',
    'r1 I1: an Off held waits for the growing retries',
  ),
  M(
    A,
    "else if (message.code !== undefined || /Resp$/.test(message.method ?? '')) return;",
    '',
    'r1 I3: an unmatched answer taken for a push',
  ),
  M(
    L,
    "if (message.seq === undefined && /Resp$/.test(message.method ?? '')) {",
    'if (false) {',
    'r1 I3: a late answer without seq given to the request in flight',
  ),
  M(
    A,
    'mono + Math.min(TIMINGS.cloudGap * 2 ** (entry.cloudAsks - 1), TIMINGS.cloudRefresh);',
    'mono;',
    'r1 M3: the cloud asked again without a growing wait',
  ),
  M(
    D,
    '(a === 100 && b >= 64 && b <= 127);',
    '(a === 100 && b >= 64 && b <= 127) || a === 127;',
    'r1 M6: loopback accepted',
  ),
  M(
    A,
    "if (power === false && (kind !== 'read' || tick > guard.tick)) {",
    'if (false) {',
    'r1 I3: an Off seen off while in flight not ended',
  ),
];
