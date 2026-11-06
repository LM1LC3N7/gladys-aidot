// -----------------------------------------------------------------------------
// Review r2 (lot 20): an Off held after a restart never makes the password
// posted every minute to a sign-in that answers an error (I5); a good read ends
// a pause (m2); the reviewer's surviving mutants (m3).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { F, MINUTE, SECOND, START, created, setup } from './helpers/app.js';
import { testClock } from './kit/index.mjs';
import { LAMP, fakeAidot } from './helpers/fakeAidot.js';

const houses = (world) => world.cloud.requests.filter((r) => r.path === '/houses').length;

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
}

test('I5: an Off held, a sign-in answering an error: tried after 1, 2, 5, then every 10 min, never every minute', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  await heldOff(clock, world, store);
  world.cloud.signInError = true;
  const signIns = world.cloud.signIns;
  const again = await setup({ store, clock, world });
  t.after(() => again.app.stop());
  await again.wait(30 * MINUTE);
  const posted = world.cloud.signIns - signIns;
  assert.ok(posted >= 4 && posted <= 7, `${posted} sign-ins in 30 min`);
  assert.match(again.status().message.en, /answers an error/);
  assert.doesNotMatch(again.status().message.en, /refused/);
  world.cloud.signInError = false;
  await again.wait(11 * MINUTE);
  assert.equal(world.lights.get(LAMP).state.OnOff, 0, 'the Off leaves once the sign-in works');
});

test('m2: a good read ends the pause (the status no longer says "asked to wait")', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  await heldOff(clock, world, store);
  world.cloud.rate = 1;
  world.cloud.retryAfter = 3600;
  const paused = await setup({ store, clock, world });
  await paused.wait(70 * SECOND);
  paused.app.stop();
  const again = await setup({ store, clock, world });
  t.after(() => again.app.stop());
  await again.wait(11 * MINUTE);
  assert.equal(world.lights.get(LAMP).state.OnOff, 0);
  assert.doesNotMatch(again.status().message.en, /asked to wait/);
  assert.equal(again.store.data.pause?.until, undefined);
});

test('m3#1: an Off held for a light not in the account: the cloud not read every minute after a good read', async (t) => {
  const ghost = { ...created(LAMP), external_id: 'ext:aidot:light:ghost0001' };
  ghost.features = ghost.features.map((f) => ({
    ...f,
    external_id: f.external_id.replace(LAMP, 'ghost0001'),
  }));
  const s = await setup({ devices: [created(LAMP), ghost] });
  t.after(() => s.app.stop());
  const out = await s.cmd('ext:aidot:light:ghost0001:power', 0, ghost);
  assert.match(out.error, /gardé|kept/);
  const before = houses(s.world);
  await s.wait(30 * MINUTE);
  assert.ok(houses(s.world) - before <= 1, `${houses(s.world) - before} reads in 30 min`);
  assert.match(s.status().message.en, /not in the list of the account/);
  // A pause asked by AiDot is then the whole pause: the exception is for a key not read yet.
  s.world.cloud.rate = 1;
  s.world.cloud.retryAfter = 3600;
  await s.act(s.gladys.fake.scanRequest());
  const paused = s.world.cloud.requests.length;
  await s.cmd('ext:aidot:light:ghost0001:power', 0, ghost);
  await s.wait(40 * MINUTE);
  assert.equal(s.world.cloud.requests.length, paused, 'nothing during the pause');
});

test('m3#2: once the cloud gives another key, the growing wait starts again', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const lamp = s.world.lights.get(LAMP);
  // A light that does not open (another id) for 3.5 min: the cloud asked at 0, 1, 3 min.
  s.world.otherId.add(LAMP);
  s.world.dropAll();
  await s.wait(210 * SECOND);
  s.world.otherId.delete(LAMP);
  // The key changes (the light paired again): Discover reads it, the light connects.
  lamp.key = 'kEyLaMpNEW00001x';
  s.world.dropAll();
  await s.wait(61 * SECOND);
  await s.act(s.gladys.fake.scanRequest());
  await s.wait(5 * SECOND);
  assert.ok(s.app.lights.get(LAMP).conn, 'connected with the new key');
  // Paired again at once: the cloud is asked again a minute after the last read, not 4 min.
  lamp.key = 'kEyLaMpNEW00002y';
  s.world.dropAll();
  await s.wait(90 * SECOND);
  assert.ok(s.app.lights.get(LAMP).conn, 'connected with the second key within 90 s');
});

test('m3#4: an answer without code nor seq (a ...Resp) is never a push', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const entry = s.app.lights.get(LAMP);
  s.app.onMessage(
    entry,
    entry.link,
    { method: 'getDevAttrResp', state: { dim: 3 } },
    entry.conn,
    undefined,
  );
  assert.equal(entry.state.dim, 40);
});
