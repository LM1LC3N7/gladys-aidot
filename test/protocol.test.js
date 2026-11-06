// -----------------------------------------------------------------------------
// The local protocol (pure): keys as python-aidot builds them, frames bounded,
// strict attributes (out of range = unknown, never a value), the discovery in
// one envelope of 512 bytes at most, the address and capability rules of the
// cloud list.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import {
  DISCOVERY_KEY,
  actionRequest,
  aesKeyOf,
  attrOf,
  decrypt,
  discoveryPayload,
  encodeMessage,
  encrypt,
  frameOf,
  frameReader,
  isId,
  macOf,
  openBody,
  readDiscovery,
  readMessage,
  rgbOf,
  rgbwOf,
  sealPassword,
  stateOf,
  timestampOf,
} from '../src/protocol.js';
import { capabilitiesOf, lanAddress, lightOf, nameOf } from '../src/model.js';

test('the key of a light: zero-padded to 16 bytes, 24 and 32 kept, anything else refused', () => {
  assert.deepEqual(aesKeyOf('abc'), Buffer.concat([Buffer.from('abc'), Buffer.alloc(13)]));
  assert.equal(aesKeyOf('a'.repeat(16)).length, 16);
  assert.equal(aesKeyOf('a'.repeat(24)).length, 24);
  assert.equal(aesKeyOf('a'.repeat(32)).length, 32);
  for (const bad of ['', 'a'.repeat(17), 'a'.repeat(40), 'ab\ncd', null, undefined, 12]) {
    assert.equal(aesKeyOf(bad), undefined, String(bad));
  }
});

test('AES-ECB with PKCS#7, as python-aidot (a known vector)', () => {
  const key = aesKeyOf('T54uednca587');
  // AES-128-ECB of "hello" padded with 11 bytes of 0x0b, computed independently.
  const raw = createDecipheriv('aes-128-ecb', key, null);
  raw.setAutoPadding(false);
  const plain = Buffer.concat([raw.update(encrypt(Buffer.from('hello'), key)), raw.final()]);
  assert.deepEqual(plain, Buffer.concat([Buffer.from('hello'), Buffer.alloc(11, 11)]));
  assert.equal(decrypt(encrypt(Buffer.from('x'.repeat(40)), key), key).toString(), 'x'.repeat(40));
  assert.throws(() => decrypt(encrypt(Buffer.from('hello'), key), aesKeyOf('other')));
});

test('frames: magic, type, length; glued and split frames; a wrong magic or a big frame throws', () => {
  const key = aesKeyOf('k');
  const a = encodeMessage({ a: 1 }, key);
  const b = encodeMessage({ b: 2 }, key, 2);
  assert.equal(a.readUInt16BE(0), 0x1eed);
  assert.equal(b.readInt16BE(2), 2);
  assert.equal(a.readInt32BE(4), a.length - 8);
  const reader = frameReader();
  const both = Buffer.concat([a, b]);
  assert.equal(reader.push(both.subarray(0, 5)).length, 0);
  const frames = reader.push(both.subarray(5));
  assert.deepEqual(
    frames.map((f) => [f.type, openBody(f.body, key)]),
    [
      [1, { a: 1 }],
      [2, { b: 2 }],
    ],
  );
  assert.throws(() => frameReader().push(Buffer.from('HTTP/1.1 200 OK\r\n')), /not a frame/);
  const header = frameOf(1, Buffer.alloc(0));
  header.writeUInt32BE(17 * 1024, 4);
  assert.throws(() => frameReader().push(header), /too large/);
  assert.equal(openBody(Buffer.from('nonsense-nonsense'), key), undefined);
});

test('the messages: long form with simpleVersion, short form without; RGBW packed as python-aidot', () => {
  const base = {
    userId: 'u1',
    deviceId: 'd1',
    password: 'p',
    ascNumber: 6,
    attr: { OnOff: 0 },
    seq: 's',
    tst: 1,
  };
  const long = actionRequest({ ...base, method: 'setDevAttrReq', simpleVersion: '1' });
  assert.equal(long.clientId, 'gl-u1');
  assert.equal(long.srcAddr, '0.u1');
  assert.deepEqual(long.payload, {
    devId: 'd1',
    parentId: 'd1',
    userId: 'u1',
    password: 'p',
    attr: { OnOff: 0 },
    channel: 'tcp',
    ascNumber: 6,
  });
  const short = actionRequest({ ...base, method: 'setDevAttrReq' });
  assert.equal(short.clientId, '');
  assert.equal(short.payload.password, '');
  assert.equal(short.deviceId, 'd1');
  assert.equal(rgbwOf(0xff0000), -16777216);
  assert.equal(rgbwOf(0x00ff00), 0x00ff0000);
  assert.equal(rgbOf(rgbwOf(0x123456)), 0x123456);
  assert.equal(rgbOf(0xff000000), 0xff0000);
  assert.equal(rgbOf(0), undefined);
  assert.deepEqual(attrOf({ power: true, dim: 50 }), { Dimming: 50, OnOff: 1 });
  assert.deepEqual(attrOf({ power: true, rgb: 0x00ff00 }), { RGBW: 0x00ff0000, OnOff: 1 });
  assert.match(timestampOf(Date.UTC(2026, 0, 2, 3, 4, 5, 6)), /^2026-01-0\d \d\d:04:05\.006000$/);
});

test('attributes are strict: out of range or of the wrong type is unknown, never 0', () => {
  assert.deepEqual(stateOf({ OnOff: 1, Dimming: 40, RGBW: 0xff000000, CCT: 3000 }), {
    power: true,
    dim: 40,
    rgb: 0xff0000,
    cct: 3000,
  });
  assert.deepEqual(stateOf({ OnOff: '0', Dimming: '7' }), { power: false, dim: 7 });
  assert.equal(stateOf({ OnOff: 2, Dimming: 101, CCT: 50, RGBW: 0 }), undefined);
  assert.equal(stateOf({ OnOff: '', Dimming: '', CCT: null }), undefined);
  assert.equal(stateOf({ Dimming: 4.5 }), undefined);
  assert.equal(stateOf([1]), undefined);
  assert.equal(stateOf(undefined), undefined);
  const message = readMessage({
    seq: 'x',
    ack: { code: '200' },
    payload: { ascNumber: 9, attr: { OnOff: 0 } },
  });
  assert.deepEqual(message.state, { power: false });
  assert.equal(message.code, 200);
  assert.equal(message.ascNumber, 9);
  assert.equal(readMessage({ seq: 'x'.repeat(100) }).seq, undefined);
});

test('the discovery: one AES-256 envelope under 512 bytes, the answers read strictly', () => {
  const payload = discoveryPayload({ userId: 'a'.repeat(64), now: Date.UTC(2026, 0, 1) });
  assert.ok(payload.length <= 512, `${payload.length} bytes`);
  const request = JSON.parse(decrypt(payload, DISCOVERY_KEY).toString());
  assert.equal(request.method, 'devDiscoveryReq');
  assert.equal(request.srcAddr, `0.${'a'.repeat(64)}`);
  assert.equal(request.payload.localCtrFlag, 1);
  const reply = encrypt(
    Buffer.from(JSON.stringify({ payload: { devId: 'abc', mac: 'AA:BB:CC:DD:EE:FF' } })),
    DISCOVERY_KEY,
  );
  assert.deepEqual(readDiscovery(reply), { id: 'abc', mac: 'aa:bb:cc:dd:ee:ff' });
  const bad = encrypt(Buffer.from(JSON.stringify({ payload: { devId: '../x' } })), DISCOVERY_KEY);
  assert.equal(readDiscovery(bad), undefined);
  assert.equal(readDiscovery(Buffer.from('garbage-garbage!')), undefined);
  assert.equal(readDiscovery(Buffer.alloc(5000)), undefined);
  assert.equal(macOf('00:00:00:00:00:00'), undefined);
  assert.equal(macOf('aabbccddeeff'), 'aa:bb:cc:dd:ee:ff');
});

test('ids, names and addresses of the cloud list are checked', () => {
  assert.ok(isId('8a040e2233a243e7a07eb6a1b7a210a7'));
  for (const bad of ['', 'a.b', 'a:b', '..', 'a\nb', 'a'.repeat(65), 5])
    assert.equal(isId(bad), false);
  assert.equal(nameOf('  Lamp\u0000 '), 'Lamp');
  assert.equal(nameOf('x'.repeat(100)).length, 60);
  assert.equal(nameOf('   '), undefined);
  for (const ok of [
    '192.168.1.5',
    '10.0.0.7',
    '172.20.1.1',
    '169.254.3.4',
    '100.64.0.9',
    'fd00::5',
  ])
    assert.ok(lanAddress(ok), ok);
  for (const bad of [
    '8.8.8.8',
    '127.0.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '192.168.1.255',
    '192.168.1.0',
    'lamp.local',
    '',
    undefined,
    '::1',
  ])
    assert.equal(lanAddress(bad), undefined, String(bad));
});

test('a cloud device: lights with a key only; capabilities from the product, bounded', () => {
  const raw = {
    id: 'd1',
    type: 'light',
    aesKey: ['k1'],
    password: 'p',
    properties: { ipAddress: '192.168.1.9' },
  };
  const { light } = lightOf(raw);
  assert.equal(light.ip, '192.168.1.9');
  assert.equal(light.caps.known, false);
  assert.equal(lightOf({ ...raw, type: 'plug' }).skip, 'not_light');
  assert.equal(lightOf({ ...raw, aesKey: [null] }).skip, 'no_key');
  assert.equal(lightOf({ ...raw, id: 'a.b' }).skip, 'bad_id');
  assert.equal(lightOf({ ...raw, properties: { ipAddress: '8.8.8.8' } }).light.ip, undefined);
  assert.deepEqual(capabilitiesOf({ serviceModules: [{ identity: 'control.light.rgbw' }] }), {
    known: true,
    color: true,
    cct: { min: 2700, max: 6500 },
  });
  assert.deepEqual(
    capabilitiesOf({
      serviceModules: [
        { identity: 'control.light.cct', properties: [{ minValue: '2200', maxValue: 5000 }] },
      ],
    }).cct,
    { min: 2200, max: 5000 },
  );
  assert.deepEqual(
    capabilitiesOf({
      serviceModules: [
        { identity: 'control.light.cct', properties: [{ minValue: 0, maxValue: 99999 }] },
      ],
    }).cct,
    { min: 2700, max: 6500 },
  );
  assert.deepEqual(capabilitiesOf(undefined), { known: false, color: false, cct: undefined });
});

test('the password goes under the public key of the library (RSA 1024, base64), never as is', () => {
  const sealed = sealPassword('secret-password');
  assert.equal(Buffer.from(sealed, 'base64').length, 128);
  assert.ok(!sealed.includes('secret'));
  assert.notEqual(sealPassword('secret-password'), sealed, 'PKCS#1 v1.5 is randomized');
});
