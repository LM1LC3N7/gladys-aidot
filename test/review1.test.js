// -----------------------------------------------------------------------------
// Review r1 (lot 20): an Off held after a restart and the cloud (I1), a report
// equal to the state of before (I2, in off.test.js), answers without `seq`
// (I3), the reviewer's surviving mutants (I4), the cloud asked again with a
// growing wait for a light that does not open (M3).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { httpsRequest } from '../src/http.js';
import { accountKeyOf, normalizeConfig, passwordMarkOf } from '../src/config.js';
import { memoryStore } from '../src/store.js';
import { CONFIG, F, MINUTE, SECOND, START, setup } from './helpers/app.js';
import { testClock } from './kit/index.mjs';
import { KEY_BULB, KEY_LAMP, LAMP, PASSWORD, fakeAidot } from './helpers/fakeAidot.js';

const offs = (s, id = LAMP) =>
  s.world.sets(id).filter((a) => a.OnOff === 0 && Object.keys(a).length === 1).length;

/** A first run that holds an Off of the lamp in /data (the lamp refusing connections), then stops. */
async function heldOff(clock, world, store) {
  const s = await setup({ store, clock, world });
  world.refuse.add(LAMP);
  world.dropAll();
  await s.wait(SECOND);
  await s.cmd(F(LAMP, 'power'), 0);
  await s.wait(SECOND);
  s.app.stop();
  world.refuse.delete(LAMP);
  assert.equal(store.data.guards.length, 1);
  assert.ok(!JSON.stringify(store.data).includes(KEY_LAMP), 'no key of a light in /data');
  assert.ok(!JSON.stringify(store.data).includes(KEY_BULB));
}

test('I1: an Off held across a restart goes despite a 429 pause kept (10 min at most)', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  await heldOff(clock, world, store);
  // A 429 asking 1 h, kept in /data.
  world.cloud.rate = 1;
  world.cloud.retryAfter = 3600;
  const paused = await setup({ store, clock, world });
  await paused.wait(70 * SECOND);
  assert.equal(world.lights.get(LAMP).state.OnOff, 1, 'not gone yet (paused before the key)');
  paused.app.stop();
  assert.ok(store.data.pause.until > clock.now() + 50 * MINUTE);
  const again = await setup({ store, clock, world });
  t.after(() => again.app.stop());
  await again.wait(11 * MINUTE);
  assert.equal(world.lights.get(LAMP).state.OnOff, 0, 'the Off left within the pause');
  assert.equal(again.app.guards.size, 0);
  const reads = world.cloud.requests.filter((r) => r.path === '/houses').length;
  assert.ok(reads <= 4, `${reads} reads: no storm under the pause`);
});

test('I1: cloud not reached after a restart with an Off held: a try every minute, then it goes', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  await heldOff(clock, world, store);
  world.cloud.down = true;
  const again = await setup({ store, clock, world });
  t.after(() => again.app.stop());
  const before = world.cloud.requests.length;
  await again.wait(10 * MINUTE);
  const tries = world.cloud.requests.length - before;
  assert.ok(tries >= 9 && tries <= 11, `${tries} tries in 10 min`);
  assert.match(again.status().message.en, /Off of Lamp: kept/);
  world.cloud.down = false;
  await again.wait(70 * SECOND);
  assert.equal(world.lights.get(LAMP).state.OnOff, 0);
});

test('I1: credentials refused and kept: the Off held cannot go, the status says why', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  await heldOff(clock, world, store);
  world.cloud.refuse = true;
  const refused = await setup({ store, clock, world });
  await refused.wait(70 * SECOND);
  refused.app.stop();
  assert.ok(store.data.refused);
  const signIns = world.cloud.signIns;
  const again = await setup({ store, clock, world });
  t.after(() => again.app.stop());
  await again.wait(30 * MINUTE);
  assert.equal(world.cloud.signIns, signIns, 'the refused password never posted for the Off');
  assert.match(again.status().message.en, /Off of Lamp: kept.*refused/);
});

test('I3: a light that echoes no seq: a late answer to a read never applies after a command', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.noSeq.add(LAMP);
  s.world.pushDelay = 0;
  // Every read answered 2.5 s late: the old answer comes while the read of the command is in flight.
  s.world.getLatency = 2500;
  const entry = s.app.lights.get(LAMP);
  const dims = [];
  const queue = s.app.queueStates.bind(s.app);
  s.app.queueStates = (e) => {
    if (e === entry) dims.push(e.state.dim);
    return queue(e);
  };
  s.app.readLight(entry, { priority: 2 });
  await s.wait(2100);
  const out = await s.cmd(F(LAMP, 'brightness'), 15);
  assert.ok(out.success || /sans confirmation/.test(out.error));
  await s.wait(6 * SECOND);
  assert.equal(entry.state.dim, 15);
  const from = dims.indexOf(15);
  assert.ok(from !== -1);
  assert.deepEqual(
    dims.slice(from).filter((d) => d !== 15),
    [],
    `never the state of before after the command: ${dims}`,
  );
});

test('I3: without seq, a late answer is never given to the request in flight', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.noSeq.add(LAMP);
  s.world.getLatency = 2500;
  const entry = s.app.lights.get(LAMP);
  const link = entry.link;
  const seen = [];
  const original = link.onMessage;
  link.onMessage = (message, conn, job) => {
    seen.push({ seq: message.seq, job: job?.seq });
    return original(message, conn, job);
  };
  const sent = [];
  const request = link.request.bind(link);
  link.request = (what, options) =>
    request(what, { ...options, onSent: (at, seq) => (sent.push(seq), options.onSent?.(at, seq)) });
  s.app.readLight(entry, { priority: 2 });
  await s.wait(2100);
  s.app.readLight(entry, { priority: 2 });
  await s.wait(600);
  // The answer of the first read (2.5 s late) cannot be dated: dropped, never the second's.
  assert.equal(seen.filter((m) => m.job === sent[1]).length, 0);
  assert.equal(entry.link.inFlight?.seq, sent[1], 'the second read still waits for its own answer');
});

test('I3: an Off seen off by a report while it is in flight is done (its read answered too late)', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.pushFirst = true;
  s.world.latency = 300;
  s.world.getLatency = 5000;
  assert.deepEqual(await s.cmd(F(LAMP, 'power'), 0), { success: true });
  assert.equal(s.app.guards.size, 0);
});

test('I3: an answer without seq matched to nothing is never a push', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const entry = s.app.lights.get(LAMP);
  s.app.onMessage(
    entry,
    entry.link,
    { method: 'getDevAttrResp', code: 200, state: { dim: 3 } },
    entry.conn,
    undefined,
  );
  assert.equal(entry.state.dim, 40);
});

test('I4#3: the answer to an older command never applies after a newer one left', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const entry = s.app.lights.get(LAMP);
  s.app.rememberSet(entry, 'old-set', ++s.app.tick);
  entry.mark = ++s.app.tick;
  s.app.onMessage(
    entry,
    entry.link,
    { seq: 'old-set', code: 200, method: 'setDevAttrResp', state: { dim: 3 } },
    entry.conn,
    undefined,
  );
  assert.equal(entry.state.dim, 40);
});

test('I4#0: a sign-in answered 401 without code 560080 is never a refusal', async (t) => {
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  world.cloud.next.push(() => ({ status: 401, headers: {}, body: '{}' }));
  const s = await setup({ clock, world });
  t.after(() => s.app.stop());
  assert.doesNotMatch(s.status().message.en, /refused/);
  assert.equal(s.store.data?.refused, undefined);
  await s.wait(70 * SECOND);
  assert.equal(s.status().connected, true, 'tried again later');
});

test('I4#1: an Off without an answer is sent again every 10 s', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.muteSet.add(LAMP);
  await s.cmd(F(LAMP, 'power'), 0);
  await s.wait(MINUTE);
  assert.ok(offs(s) >= 6, `${offs(s)} sends in a minute`);
});

test('I4#6: a Retry-After of 30 h is bounded to a 6 h pause', async (t) => {
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  world.cloud.rate = 1;
  world.cloud.retryAfter = 30 * 3600;
  const s = await setup({ clock, world });
  t.after(() => s.app.stop());
  await s.wait(SECOND);
  assert.ok(s.app.pauseUntil - clock.monotonic() <= 6 * 3600 * 1000);
  assert.ok(s.store.data.pause.until <= clock.now() + 6 * 3600 * 1000);
});

test('I4#22-23: the acks of a command and of an Off come within 5 s, the light silent', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.silent.add(LAMP);
  for (const [key, value] of [
    ['brightness', 30],
    ['power', 0],
  ]) {
    const at = s.clock.monotonic();
    const out = await s.cmd(F(LAMP, key), value);
    assert.equal(out.success, false);
    assert.ok(
      s.clock.monotonic() - at < 4800,
      `${key}: ${Math.round(s.clock.monotonic() - at)} ms`,
    );
  }
});

test('I4#22: a command waiting for a slow connection is answered within 5 s', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.dropAll();
  await s.wait(100);
  s.world.connectDelay = 1900;
  s.world.latency = 1800;
  const at = s.clock.monotonic();
  const out = await s.cmd(F(LAMP, 'brightness'), 30);
  assert.equal(out.success, false);
  assert.ok(s.clock.monotonic() - at < 4800, `${Math.round(s.clock.monotonic() - at)} ms`);
});

test('I4: an Off answered but not applied is kept as answered (judged by a read after a restart)', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.ignoreSet.add(LAMP);
  await s.cmd(F(LAMP, 'power'), 0);
  await s.wait(SECOND);
  assert.equal(s.store.data.guards[0].accepted, true);
});

test('I4#10: a command clicked while an Off of the light is being sent: refused, never sent', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.dropAll();
  await s.wait(100);
  s.world.connectDelay = 1500;
  const lamp = s.gladys.fake.devices[0];
  const off = s.gladys.fake.setValue(lamp, { external_id: F(LAMP, 'power') }, 0);
  await s.wait(200);
  const on = s.gladys.fake.setValue(lamp, { external_id: F(LAMP, 'brightness') }, 90);
  const [a, b] = await s.act(Promise.all([off, on]));
  assert.deepEqual(a, { success: true });
  assert.match(b.error, /arrêt est en cours|Off is being sent/);
  await s.wait(5 * SECOND);
  assert.deepEqual(
    s.world.sets(LAMP).filter((x) => x.Dimming === 90),
    [],
  );
});

test('I4#7: an HTTP body over the bound is cut before it is read whole', async (t) => {
  let written = 0;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 32);
    const pump = () => {
      while (written < 8 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  server.on('connection', (socket) => socket.on('error', () => {}));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => server.closeAllConnections());
  await assert.rejects(
    httpsRequest(`http://127.0.0.1:${server.address().port}/`, {
      maxBytes: 256 * 1024,
      timeout: 5000,
    }),
    (err) => err.code === 'size',
  );
});

test('I4#20: after a restart, another password of the refused account is tried', async (t) => {
  const salt = '0'.repeat(32);
  const refusedPassword = 'old-wrong-password';
  const config = normalizeConfig(CONFIG);
  const wrong = normalizeConfig({ ...CONFIG, password: refusedPassword });
  assert.notEqual(
    passwordMarkOf(refusedPassword, salt),
    passwordMarkOf(PASSWORD, salt),
    'precondition',
  );
  const store = memoryStore({
    format: 1,
    salt,
    terminal: '1'.repeat(32),
    refused: { account: accountKeyOf(wrong, salt), mark: passwordMarkOf(refusedPassword, salt) },
    guards: [],
  });
  assert.equal(accountKeyOf(config, salt), accountKeyOf(wrong, salt));
  const s = await setup({ store });
  t.after(() => s.app.stop());
  assert.equal(s.world.cloud.signIns, 1);
  assert.equal(s.status().connected, true);
});

test('M3: a light that does not open with its key asks the cloud again with a growing wait', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.otherId.add(LAMP);
  s.world.dropAll();
  const before = s.world.cloud.requests.filter((r) => r.path === '/houses').length;
  await s.wait(60 * MINUTE);
  const reads = s.world.cloud.requests.filter((r) => r.path === '/houses').length - before;
  assert.ok(reads >= 3 && reads <= 7, `${reads} reads of the cloud in 1 h`);
});

test('Test the connection while a read is in progress: a read and a sign-in of its own after it', async (t) => {
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  world.cloud.latency = 3000;
  const s = await setup({ clock, world });
  t.after(() => s.app.stop());
  assert.ok(s.app.cloudReading, 'the first read still in progress');
  const ack = await s.act(s.gladys.fake.action('test_connection'));
  assert.match(ack.data.message, /Connecté|Signed in/);
  assert.equal(world.cloud.signIns, 2);
});
