// -----------------------------------------------------------------------------
// The Offs (power 0, brightness 0), protective: they go whatever else is in
// flight, paused, refused or not read; a send that never left is never given
// up; nothing clicked before an Off leaves after it; an Off answered but not
// applied is sent again (4 answered tries at most); turned on elsewhere after
// its answer, it is no longer held; held in /data across a restart.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { CONFIG, F, MINUTE, SECOND, START, created, setup } from './helpers/app.js';
import { testClock } from './kit/index.mjs';
import { BULB, LAMP, LIGHTS, fakeAidot } from './helpers/fakeAidot.js';

const offs = (s, id = LAMP) =>
  s.world.sets(id).filter((a) => a.OnOff === 0 && Object.keys(a).length === 1).length;

test('an Off is confirmed by the read right after it; nothing held', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  assert.deepEqual(await s.cmd(F(LAMP, 'power'), 0), { success: true });
  assert.equal(s.world.lights.get(LAMP).state.OnOff, 0);
  assert.equal(s.app.guards.size, 0);
  assert.deepEqual(await s.cmd(F(LAMP, 'brightness'), 0), { success: true }, 'brightness 0 = Off');
  await s.wait(SECOND);
  assert.deepEqual(s.store.data.guards, []);
});

test('an Off cuts a read stuck for 1 s, on a new connection (never two at once)', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.muteGet.add(LAMP);
  const entry = s.app.lights.get(LAMP);
  s.app.readLight(entry, { priority: 2 });
  await s.wait(100);
  s.world.muteGet.delete(LAMP);
  const clicked = s.clock.monotonic();
  const out = await s.cmd(F(LAMP, 'power'), 0);
  assert.deepEqual(out, { success: true });
  const sent = s.world.received.find((r) => r.id === LAMP && r.message?.payload?.attr?.OnOff === 0);
  assert.ok(
    sent.at - clicked < 1300,
    `the Off left ${Math.round(sent.at - clicked)} ms after the click`,
  );
  assert.equal(s.world.peak, 2, 'one connection per light at a time');
  assert.equal(s.world.lights.get(LAMP).state.OnOff, 0);
});

test('a light that refuses connections: the Off kept, sent every 10 s, never given up', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.refuse.add(LAMP);
  s.world.dropAll();
  await s.wait(SECOND);
  const out = await s.cmd(F(LAMP, 'power'), 0);
  assert.equal(out.success, false);
  assert.match(out.error, /gardé|kept/);
  assert.match(s.status().message.en, /Off of Lamp: not sent/);
  assert.equal(s.store.data.guards.length, 1);
  const tries = s.world.attempts;
  await s.wait(10 * MINUTE);
  assert.ok(s.world.attempts - tries >= 30, `${s.world.attempts - tries} tries in 10 min`);
  assert.ok(s.world.attempts - tries <= 70, 'no storm');
  s.world.refuse.delete(LAMP);
  await s.wait(11 * SECOND);
  assert.equal(s.world.lights.get(LAMP).state.OnOff, 0);
  assert.equal(s.app.guards.size, 0);
});

test('an Off before the cloud is read: kept, sent as soon as the cloud gives the light', async (t) => {
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  world.cloud.down = true;
  const s = await setup({ clock, world });
  t.after(() => s.app.stop());
  const out = await s.cmd(F(LAMP, 'power'), 0);
  assert.equal(out.success, false);
  assert.match(out.error, /gardé|kept/);
  assert.match(s.status().message.en, /Off of Lamp: kept, sent as soon as the light is known/);
  world.cloud.down = false;
  await s.wait(70 * SECOND);
  assert.equal(world.lights.get(LAMP).state.OnOff, 0);
  assert.equal(s.app.guards.size, 0);
});

test('an Off goes with the cloud refused, paused or down, and getConfig failing (the light known)', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.cloud.rate = 99;
  s.world.cloud.refuse = true;
  s.world.cloud.down = true;
  s.gladys.getConfig = () => Promise.reject(new Error('no Gladys'));
  s.app.onConnected(() => s.gladys.getConfig()).catch(() => {});
  await s.wait(SECOND);
  assert.deepEqual(await s.cmd(F(LAMP, 'power'), 0), { success: true });
  assert.equal(s.world.lights.get(LAMP).state.OnOff, 0);
});

test('nothing clicked before an Off leaves after it (a command waiting for the connection)', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.dropAll();
  await s.wait(100);
  s.world.connectDelay = 1500;
  const lamp = s.gladys.fake.devices[0];
  const on = s.gladys.fake.setValue(lamp, { external_id: F(LAMP, 'brightness') }, 90);
  await s.wait(200);
  const off = s.gladys.fake.setValue(lamp, { external_id: F(LAMP, 'power') }, 0);
  const [a, b] = await s.act(Promise.all([on, off]));
  assert.equal(a.success, false);
  assert.match(a.error, /Annulée|Cancelled/);
  assert.deepEqual(b, { success: true });
  await s.wait(5 * SECOND);
  assert.deepEqual(
    s.world.sets(LAMP).filter((x) => x.Dimming === 90),
    [],
    'the brightness never left',
  );
  assert.equal(s.world.lights.get(LAMP).state.OnOff, 0);
});

test('answered but still on: sent again every 10 s, 4 answered tries, then said in the status', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.ignoreSet.add(LAMP);
  const out = await s.cmd(F(LAMP, 'power'), 0);
  assert.equal(out.success, false);
  assert.match(out.error, /sans confirmation|without confirmation/);
  await s.wait(2 * MINUTE);
  assert.equal(offs(s), 4);
  assert.match(s.status().message.en, /answered 4 times/);
  // A new click starts again.
  s.world.ignoreSet.delete(LAMP);
  assert.deepEqual(await s.cmd(F(LAMP, 'power'), 0), { success: true });
});

test('answered, then turned on at the switch: no longer held, never undone', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.ignoreSet.add(LAMP);
  await s.cmd(F(LAMP, 'power'), 0);
  s.world.ignoreSet.delete(LAMP);
  s.world.wall(LAMP, { OnOff: 1 });
  await s.wait(100);
  assert.equal(s.app.guards.size, 0);
  const sent = offs(s);
  await s.wait(MINUTE);
  assert.equal(offs(s), sent);
  assert.equal(s.world.lights.get(LAMP).state.OnOff, 1);
});

test('held in /data across a restart: sent once the cloud gives the light, before any read', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  const s = await setup({ store, clock, world });
  world.refuse.add(LAMP);
  world.dropAll();
  await s.wait(SECOND);
  await s.cmd(F(LAMP, 'power'), 0);
  await s.wait(SECOND);
  s.app.stop();
  assert.equal(store.data.guards.length, 1);
  world.refuse.delete(LAMP);
  world.received.length = 0;
  const again = await setup({ store, clock, world });
  t.after(() => again.app.stop());
  await again.wait(70 * SECOND);
  const lamp = world.received.filter((r) => r.id === LAMP && r.message?.method !== 'loginReq');
  assert.equal(lamp[0].message.method, 'setDevAttrReq');
  assert.deepEqual(lamp[0].message.payload.attr, { OnOff: 0 });
  assert.equal(world.lights.get(LAMP).state.OnOff, 0);
  assert.equal(again.app.guards.size, 0);
});

test('/data frozen: several Offs in a row still go', async (t) => {
  const store = memoryStore();
  const s = await setup({ store });
  t.after(() => s.app.stop());
  store.hang = true;
  const bulb = s.gladys.fake.devices[1];
  s.world.wall(BULB, { OnOff: 1 });
  await s.wait(100);
  assert.deepEqual(await s.cmd(F(LAMP, 'power'), 0), { success: true });
  assert.deepEqual(await s.cmd(F(BULB, 'power'), 0, bulb), { success: true });
  assert.deepEqual(await s.cmd(F(LAMP, 'brightness'), 0), { success: true });
  assert.equal(s.world.lights.get(BULB).state.OnOff, 0);
});

test('a scene of Offs on 5 slow lights (600 ms each): all 5 off', async (t) => {
  const clock = testClock({ start: START });
  const extra = [0, 1, 2].map((i) => ({
    ...LIGHTS()[1],
    id: `extra${i}`,
    name: `Extra ${i}`,
    ip: `192.168.1.${60 + i}`,
    mac: `AA:BB:CC:00:01:0${i}`,
    state: { OnOff: 1, Dimming: 50, CCT: 3000 },
  }));
  const world = fakeAidot({ clock, lights: [...LIGHTS(), ...extra] });
  world.lights.get(BULB).state.OnOff = 1;
  const devices = [created(LAMP), created(BULB), ...extra.map((l) => created(l.id))];
  const s = await setup({ clock, world, devices });
  t.after(() => s.app.stop());
  world.latency = 600;
  const acks = await s.act(
    Promise.all(
      devices.map((d) => s.gladys.fake.setValue(d, { external_id: `${d.external_id}:power` }, 0)),
    ),
  );
  await s.wait(15 * SECOND);
  for (const id of world.lights.keys()) assert.equal(world.lights.get(id).state.OnOff, 0, id);
  assert.ok(acks.every((a) => a.success || /sans confirmation/.test(a.error)));
});

test('an Off of a light deleted in Gladys is dropped with its connection', async (t) => {
  const s = await setup({ config: CONFIG });
  t.after(() => s.app.stop());
  s.world.refuse.add(LAMP);
  s.world.dropAll();
  await s.wait(SECOND);
  await s.cmd(F(LAMP, 'power'), 0);
  const lamp = s.gladys.fake.devices[0];
  s.gladys.fake.devices.splice(0, 1);
  await s.act(s.gladys.fake.deviceDeleted(lamp));
  assert.equal(s.app.guards.size, 0);
  const tries = s.world.attemptsTo['192.168.1.50'];
  await s.wait(MINUTE);
  assert.equal(s.world.attemptsTo['192.168.1.50'], tries);
});

test('an Off clicked while the credentials are refused: kept, sent first once new ones are saved', async (t) => {
  const clock = testClock({ start: START });
  const world = fakeAidot({ clock });
  world.cloud.refuse = true;
  const s = await setup({ clock, world });
  t.after(() => s.app.stop());
  const out = await s.cmd(F(LAMP, 'power'), 0);
  assert.match(out.error, /gardé|kept/);
  await s.wait(5 * MINUTE);
  assert.equal(world.cloud.signIns, 1, 'the refused password not posted again by the Off');
  world.cloud.refuse = false;
  await s.act(s.gladys.fake.configUpdated({ ...CONFIG, password: 'new-password' }));
  await s.wait(2 * SECOND);
  const lamp = world.received.filter((r) => r.id === LAMP && r.message?.method !== 'loginReq');
  assert.deepEqual(lamp[0].message.payload.attr, { OnOff: 0 });
  assert.equal(world.lights.get(LAMP).state.OnOff, 0);
});
