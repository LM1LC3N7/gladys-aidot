// -----------------------------------------------------------------------------
// The app end to end on the virtual clock: the cloud list, Discover, the
// local connections, states pushed and read, commands confirmed or not, the
// order of reads and commands, the bounds, the discovery through the core,
// secrets never in a log, the status or /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { commandOf, integerOf, shows } from '../src/app.js';
import { CONFIG, F, MINUTE, SECOND, created, setup } from './helpers/app.js';
import {
  ACCESS,
  BULB,
  DEVICE_PASSWORD,
  KEY_BULB,
  KEY_LAMP,
  LAMP,
  PASSWORD,
  REFRESH,
  USER_ID,
} from './helpers/fakeAidot.js';

const SECRETS = [PASSWORD, ACCESS, REFRESH, USER_ID, KEY_LAMP, KEY_BULB, DEVICE_PASSWORD];

function assertNoSecret(t) {
  const texts = [
    ...t.lines,
    JSON.stringify(t.gladys.fake.connectionStatuses),
    JSON.stringify(t.store.data ?? {}),
    JSON.stringify(t.gladys.fake.discoveredDevices),
  ].join('\n');
  for (const secret of SECRETS)
    assert.ok(!texts.includes(secret), `a secret leaked: ${secret.slice(0, 4)}…`);
}

test('commands of Gladys: 0 is an Off; values strict; nothing else', () => {
  assert.deepEqual(commandOf('power', 0), { protective: true });
  assert.deepEqual(commandOf('brightness', 0), { protective: true });
  assert.deepEqual(commandOf('brightness', 55), { target: { power: true, dim: 55 } });
  assert.deepEqual(commandOf('color', 0x00ff00), { target: { power: true, rgb: 0x00ff00 } });
  assert.equal(commandOf('color', 0), undefined);
  assert.equal(commandOf('power', 2), undefined);
  assert.equal(commandOf('brightness', 101), undefined);
  assert.equal(commandOf('temperature', 500), undefined);
  assert.equal(integerOf(''), undefined);
  assert.equal(integerOf('4.5'), undefined);
  assert.equal(integerOf(' 7 '), 7);
  assert.ok(shows({ power: true, dim: 4 }, { power: true, dim: 4, cct: 3000 }));
  assert.ok(!shows({ power: true }, undefined));
});

test('start: signed in, the lights listed with their features, connected, states published; no secret anywhere', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const listed = s.gladys.fake.discoveredDevices;
  assert.deepEqual(
    listed.map((d) => [d.name, d.features.map((f) => f.external_id.split(':').pop())]),
    [
      ['Lamp', ['power', 'brightness', 'color', 'temperature']],
      ['Bulb', ['power', 'brightness', 'temperature']],
    ],
  );
  const temp = listed[1].features.find((f) => f.type === 'temperature');
  assert.deepEqual([temp.min, temp.max], [2700, 6500]);
  assert.equal(s.status().connected, true);
  assert.equal(s.stateOf(F(LAMP, 'power')), 1);
  assert.equal(s.stateOf(F(LAMP, 'brightness')), 40);
  assert.equal(s.stateOf(F(LAMP, 'color')), 0xff0000);
  assert.equal(s.stateOf(F(BULB, 'power')), 0);
  assert.equal(s.stateOf(F(BULB, 'temperature')), 4000);
  assert.equal(s.world.cloud.signIns, 1);
  assert.equal(s.world.peak, 2, 'one connection per light');
  await s.wait(MINUTE);
  assertNoSecret(s);
  const saved = s.store.data;
  assert.match(saved.salt, /^[0-9a-f]{32}$/);
  assert.match(saved.terminal, /^[0-9a-f]{32}$/);
});

test('a change pushed by the light is published at once; reads come every interval', async (t) => {
  const s = await setup({ config: { ...CONFIG, poll_interval: 30 } });
  t.after(() => s.app.stop());
  s.world.wall(LAMP, { OnOff: 0 });
  await s.wait(100);
  assert.equal(s.stateOf(F(LAMP, 'power')), 0);
  const before = s.world.gets(LAMP).length;
  await s.wait(95 * SECOND);
  const reads = s.world.gets(LAMP).length - before;
  assert.ok(reads >= 3 && reads <= 4, `${reads} reads in 95 s at 30 s`);
});

test('commands: done once a state after the send shows it; colour and temperature bounded', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  assert.deepEqual(await s.cmd(F(LAMP, 'brightness'), 70), { success: true });
  assert.deepEqual(s.world.sets(LAMP).at(-1), { Dimming: 70, OnOff: 1 });
  assert.deepEqual(await s.cmd(F(LAMP, 'color'), 0x0000ff), { success: true });
  assert.deepEqual(s.world.sets(LAMP).at(-1), { RGBW: 0x0000ff00, OnOff: 1 });
  assert.deepEqual(await s.cmd(F(LAMP, 'temperature'), 5000), { success: true });
  const bulb = s.gladys.fake.devices[1];
  assert.deepEqual(await s.cmd(F(BULB, 'power'), 1, bulb), { success: true });
  const sets = s.world.sets(LAMP).length;
  const out = await s.cmd(F(LAMP, 'temperature'), 9000);
  assert.equal(out.success, false);
  assert.match(out.error, /2700-6500/);
  const color = await s.cmd(F(BULB, 'color'), 0x00ff00, bulb);
  assert.equal(color.success, false, 'no colour on a white light');
  assert.equal(s.world.sets(LAMP).length, sets, 'nothing sent');
  assert.equal((await s.cmd(F(LAMP, 'brightness'), 'x')).success, false);
});

test('a command answered but not applied: "shows another state", read again 5 s later', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.ignoreSet.add(LAMP);
  const out = await s.cmd(F(LAMP, 'brightness'), 90);
  assert.equal(out.success, false);
  assert.match(out.error, /autre état|another state/);
  const reads = s.world.gets(LAMP).length;
  await s.wait(6 * SECOND);
  assert.ok(s.world.gets(LAMP).length > reads, 'read again');
});

test('a light that never answers a command: "sent, without confirmation", never success', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.silent.add(LAMP);
  const out = await s.cmd(F(LAMP, 'brightness'), 90);
  assert.equal(out.success, false);
  assert.match(out.error, /sans confirmation|without confirmation/);
});

test('a command equal to the state of before, never answered: not confirmed by the old state', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.noSeq.add(LAMP);
  s.world.ignoreSet.add(LAMP);
  // Without `seq` the answer is still the setDevAttrResp of its method: answered.
  const ok = await s.cmd(F(LAMP, 'brightness'), 40);
  assert.equal(ok.success, true, 'answered by the light and showing it');
  s.world.noSeq.delete(LAMP);
  s.world.muteSet.add(LAMP);
  const out = await s.cmd(F(LAMP, 'brightness'), 40);
  assert.ok(s.world.gets(LAMP).length > 0);
  assert.equal(
    out.success,
    false,
    'no answer, a read showing the state of before: not a confirmation',
  );
  assert.match(out.error, /sans confirmation|without confirmation/);
});

test('order: a read that left before a command never applies its state after it', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  // The light answers reads late (800 ms) and a command arrives meanwhile.
  s.world.latency = 300;
  const entry = s.app.lights.get(LAMP);
  s.app.readLight(entry, { priority: 2 });
  await s.wait(50);
  const command = s.cmd(F(LAMP, 'brightness'), 15);
  const out = await command;
  assert.equal(out.success, true);
  await s.wait(2 * SECOND);
  assert.equal(s.stateOf(F(LAMP, 'brightness')), 15);
});

test('scene: commands of one light merged while waiting; 5 lights at 600 ms each all set', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.latency = 600;
  const lamp = s.gladys.fake.devices[0];
  const a = s.gladys.fake.setValue(lamp, { external_id: F(LAMP, 'brightness') }, 20);
  const b = s.gladys.fake.setValue(lamp, { external_id: F(LAMP, 'color') }, 0x00ff00);
  const c = s.gladys.fake.setValue(
    s.gladys.fake.devices[1],
    { external_id: F(BULB, 'brightness') },
    30,
  );
  const [ra, rb, rc] = await s.act(Promise.all([a, b, c]));
  assert.equal(rc.success, true);
  await s.wait(5 * SECOND);
  assert.equal(s.world.lights.get(LAMP).state.Dimming, 20);
  assert.equal(s.world.lights.get(LAMP).state.RGBW, 0x00ff0000);
  assert.equal(s.world.lights.get(BULB).state.Dimming, 30);
  assert.ok(ra.success || /sans confirmation|en file|autre état/.test(ra.error));
  assert.ok(rb.success || /sans confirmation|en file|autre état/.test(rb.error));
});

test('getConfig failing in "connected": retried with a status, then the session starts', async (t) => {
  let fail = 2;
  const s = await setup({ start: false });
  t.after(() => s.app.stop());
  const real = s.gladys.getConfig.bind(s.gladys);
  s.gladys.getConfig = () => (fail-- > 0 ? Promise.reject(new Error('boom')) : real());
  await s.start();
  assert.match(s.status().message.fr, /configuration n’a pas pu être lue/);
  await s.wait(25 * SECOND);
  assert.equal(s.status().connected, true);
  assert.equal(s.world.cloud.signIns, 1);
});

test('Discover reads the cloud a minute apart at most; the core discovery gives a new address', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.act(s.gladys.fake.scanRequest());
  assert.equal(
    s.world.cloud.requests.filter((r) => r.path === '/houses').length,
    1,
    'not within a minute',
  );
  assert.equal(s.gladys.fake.scans.length, 1);
  assert.equal(s.gladys.fake.scans[0].port, 6666);
  // The lamp moved: the cloud still gives the old address, the discovery the new one.
  const lamp = s.world.lights.get(LAMP);
  lamp.ip = '192.168.1.77';
  s.world.dropAll();
  s.gladys.fake.scanResults['udp-active-broadcast'] = s.world.discoveryReplies();
  await s.wait(61 * SECOND);
  await s.act(s.gladys.fake.scanRequest());
  await s.wait(2 * SECOND);
  assert.equal(s.app.lights.get(LAMP).light.ip, '192.168.1.77');
  assert.ok(s.app.lights.get(LAMP).conn, 'connected at the new address');
});

test('another light (another key) at the address: never a connection, the cloud asked', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.lights.get(LAMP).key = 'some-other-key00';
  s.world.dropAll();
  await s.wait(30 * SECOND);
  assert.equal(s.app.lights.get(LAMP).conn, undefined);
  assert.match(s.status().message.en, /Lamp: unreachable/);
  // The cloud gives the new key at its next read (a minute after the last at most).
  await s.wait(2 * MINUTE);
  assert.ok(s.app.lights.get(LAMP).conn, 'connected with the new key');
});

test('deviceCreated: the light connected, its state published only from the open connection', async (t) => {
  const s = await setup({ devices: [created(LAMP)] });
  t.after(() => s.app.stop());
  assert.equal(s.app.lights.get(BULB).link, undefined, 'not added: no connection');
  const bulb = created(BULB);
  s.gladys.fake.devices.push(bulb);
  await s.act(s.gladys.fake.deviceCreated(bulb));
  await s.wait(2 * SECOND);
  assert.ok(s.app.lights.get(BULB).conn);
  assert.equal(s.stateOf(F(BULB, 'power')), 0);
});

test('/data unreadable at start: read again on its own timer, never written over', async (t) => {
  const store = memoryStore({
    format: 1,
    salt: 'a'.repeat(32),
    terminal: 'b'.repeat(32),
    guards: [],
  });
  store.unreadable = true;
  const s = await setup({ store });
  t.after(() => s.app.stop());
  assert.match(s.status().message.en, /could not be read/);
  assert.equal(store.saves, 0);
  store.unreadable = false;
  await s.wait(11 * SECOND);
  assert.doesNotMatch(s.status().message.en, /could not be read/);
  assert.equal(store.data.salt, 'a'.repeat(32), 'the salt of /data kept');
});

test('stop: no timer left, nothing sent after', async () => {
  const s = await setup();
  s.app.stop();
  await s.wait(10);
  const sent = s.world.received.length;
  const requests = s.world.cloud.requests.length;
  await s.wait(10 * MINUTE);
  assert.equal(s.world.received.length, sent);
  assert.equal(s.world.cloud.requests.length, requests);
});

test('order: the late answer of a read that timed out never applies after a command', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.getLatency = 2500;
  const entry = s.app.lights.get(LAMP);
  s.app.readLight(entry, { priority: 2 });
  await s.wait(2100);
  // The read timed out (2 s); a command leaves; the old answer (brightness 40) comes after it.
  const out = await s.cmd(F(LAMP, 'brightness'), 15);
  assert.equal(out.success, true);
  await s.wait(3 * SECOND);
  assert.equal(s.stateOf(F(LAMP, 'brightness')), 15);
  assert.ok(!s.gladys.fake.states.slice(-3).some((x) => x.state === 40));
});

test('discovery: an answer with another MAC or an address outside the network is ignored', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const replies = s.world.discoveryReplies();
  const lamp = s.world.lights.get(LAMP);
  lamp.mac = 'AA:BB:CC:99:99:99';
  lamp.ip = '192.168.1.99';
  const other = s.world.discoveryReplies()[0];
  lamp.mac = 'AA:BB:CC:00:00:01';
  lamp.ip = '8.8.8.8';
  const outside = s.world.discoveryReplies()[0];
  s.gladys.fake.scanResults['udp-active-broadcast'] = [other, outside, replies[1]];
  await s.act(s.gladys.fake.scanRequest());
  assert.equal(s.app.lights.get(LAMP).light.ip, '192.168.1.50');
});

test('a light answering its login with another id or another code: never a connection', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.world.otherId.add(LAMP);
  s.world.dropAll();
  await s.wait(20 * SECOND);
  assert.equal(s.app.lights.get(LAMP).conn, undefined);
  assert.match(s.status().message.en, /Lamp: unreachable \(another light or another key/);
  s.world.otherId.delete(LAMP);
  // The password of the light changed: refused (code 401) until the cloud gives the new one.
  s.world.lights.get(LAMP).password = 'changed';
  s.world.dropAll();
  await s.wait(2 * SECOND);
  assert.equal(s.app.lights.get(LAMP).conn, undefined);
  assert.match(s.status().message.en, /refused the login/);
  await s.wait(2 * MINUTE);
  assert.ok(s.app.lights.get(LAMP).conn, 'the new password read from the cloud');
});
