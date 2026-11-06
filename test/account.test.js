// -----------------------------------------------------------------------------
// The account in the app: a refusal of the credentials kept in /data and
// never posted again by itself (restart included), new credentials or the
// button always tried; a 401 of a read never a refusal; 429 / 5xx pause the
// cloud, kept in /data across a restart; a restart never reads the cloud
// sooner than a minute; a failed read retried with a growing wait.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { CONFIG, MINUTE, SECOND, START, setup } from './helpers/app.js';
import { testClock } from './kit/index.mjs';
import { PASSWORD, fakeAidot } from './helpers/fakeAidot.js';

const signIns = (s) => s.world.cloud.signIns;

test('refused: kept in /data (a 6-bit mark, no password), never posted again, restart included', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  world.cloud.refuse = true;
  const s = await setup({ store, clock, world });
  t.after(() => s.app.stop());
  assert.equal(signIns(s), 1);
  assert.match(s.status().message.en, /refused the e-mail or the password/);
  assert.equal(s.status().connected, false);
  const saved = store.data.refused;
  assert.match(saved.account, /^[0-9a-f]{16}$/);
  assert.ok(Number.isInteger(saved.mark) && saved.mark >= 0 && saved.mark < 64);
  assert.ok(!JSON.stringify(store.data).includes(PASSWORD));
  assert.ok(!JSON.stringify(store.data).includes('me@example.com'));
  await s.wait(3 * 60 * MINUTE);
  assert.equal(signIns(s), 1, 'not posted again by itself');
  assert.equal(s.world.cloud.requests.length, 1, 'no read tried either');
  assert.ok(!s.lines.some((l) => /not read/.test(l)), 'no read attempted while refused');
  // A restart (same credentials): nothing posted.
  s.app.stop();
  const again = await setup({ store, clock, world });
  t.after(() => again.app.stop());
  await again.wait(10 * MINUTE);
  assert.equal(signIns(again), 1);
  assert.match(again.status().message.en, /refused/);
});

test('refused, then the same password saved again or another one: always tried at once', async (t) => {
  const s = await setup({ world: undefined });
  t.after(() => s.app.stop());
  s.world.cloud.refuse = true;
  s.app.cloud.session = undefined;
  s.app.cloudOkAt = undefined;
  await s.act(s.app.readCloud({ force: true, click: true }));
  assert.match(s.status().message.en, /refused/);
  const before = signIns(s);
  s.world.cloud.refuse = false;
  await s.act(s.gladys.fake.configUpdated({ ...CONFIG, password: 'a-new-one' }));
  await s.wait(SECOND);
  assert.equal(signIns(s), before + 1, 'new credentials tried at once');
  assert.doesNotMatch(s.status().message.en, /refused/);
  assert.equal(s.store.data.refused, undefined, 'a success clears the refusal');
});

test('"Test the connection" signs in even after a refusal, 10 s apart at most', async (t) => {
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  world.cloud.refuse = true;
  const s = await setup({ clock, world });
  t.after(() => s.app.stop());
  world.cloud.refuse = false;
  const ack = await s.act(s.gladys.fake.action('test_connection'));
  assert.match(ack.data.message, /Connecté|Signed in/);
  assert.equal(signIns(s), 2);
  const again = await s.act(s.gladys.fake.action('test_connection'));
  assert.match(again.data.message, /10 s/);
  assert.equal(signIns(s), 2);
  await s.wait(SECOND);
  assert.equal(s.status().connected, true);
});

test('a 401 of a read is never a refusal: one new sign-in, then "not read" and a later try', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.cloud.housesStatus = 401;
  await s.wait(61 * SECOND);
  await s.act(s.app.readCloud());
  assert.doesNotMatch(s.status().message.en, /refused/);
  assert.match(s.status().message.en, /session not accepted/);
  assert.equal(s.store.data.refused, undefined);
  assert.equal(s.status().connected, true, 'the lights still answer on the network');
});

test('429: the cloud paused (Retry-After bounded to 60 s-6 h), in /data, honoured after a restart', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  world.cloud.rate = 1;
  world.cloud.retryAfter = 2 * 3600;
  const s = await setup({ store, clock, world });
  assert.match(s.status().message.en, /asked to wait/);
  await s.wait(10 * SECOND);
  assert.ok(store.data.pause.until > START + 3600 * 1000);
  s.app.stop();
  const requests = world.cloud.requests.length;
  const again = await setup({ store, clock, world });
  t.after(() => again.app.stop());
  await again.wait(60 * MINUTE);
  assert.equal(world.cloud.requests.length, requests, 'still paused after the restart');
  const test1 = await again.act(again.gladys.fake.action('test_connection'));
  assert.match(test1.data.message, /attendre|wait/);
  await again.wait(61 * MINUTE);
  assert.ok(world.cloud.requests.length > requests, 'read once the pause is over');
  assert.equal(again.status().connected, true);
});

test('a restart reads the cloud a minute after the last attempt at the earliest', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  const s = await setup({ store, clock, world });
  await s.wait(2 * SECOND);
  s.app.stop();
  const again = await setup({ store, clock, world });
  t.after(() => again.app.stop());
  assert.equal(world.cloud.signIns, 1);
  assert.match(again.status().message.en, /read in/);
  await again.wait(60 * SECOND);
  assert.equal(world.cloud.signIns, 2);
});

test('the cloud not reached: tries 1, 2, 5 min apart; never faster', async (t) => {
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  world.cloud.down = true;
  const s = await setup({ clock, world });
  t.after(() => s.app.stop());
  const at = () => world.cloud.requests.length;
  assert.equal(at(), 1);
  await s.wait(59 * SECOND);
  assert.equal(at(), 1);
  await s.wait(2 * SECOND);
  assert.equal(at(), 2);
  await s.wait(2 * MINUTE);
  assert.equal(at(), 3);
  await s.wait(4 * MINUTE);
  assert.equal(at(), 3);
  world.cloud.down = false;
  await s.wait(2 * MINUTE);
  assert.equal(s.status().connected, true);
});

test('a config without password, or a password without e-mail: nothing posted, said in the status', async (t) => {
  const s = await setup({ config: { password: PASSWORD } });
  t.after(() => s.app.stop());
  assert.equal(s.world.cloud.requests.length, 0);
  assert.match(s.status().message.en, /without an e-mail/);
});
