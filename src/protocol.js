// -----------------------------------------------------------------------------
// The local protocol of the AiDot lights and of their discovery (pure),
// ported from python-aidot 0.3.59 (`device_client.py`, `discover.py`,
// `aes_utils.py`, `models/*`; MIT, Aidot Development Team):
//   - a frame: magic 0x1EED (2 bytes), type (int16 BE), length (int32 BE),
//     the body: the JSON message in AES-ECB / PKCS#7 with the key of the light
//     (the `aesKey` of the cloud, its bytes zero-padded to 16);
//   - the messages: `loginReq` (answered with `ack.code` 200 and the
//     `ascNumber` to use), `getDevAttrReq`, `setDevAttrReq` (attr OnOff,
//     Dimming, RGBW, CCT), the heartbeat `pingreq` (type 2); the light pushes
//     its attributes in `payload.attr`;
//   - the discovery: `devDiscoveryReq` in AES-256-ECB with the fixed key of
//     the protocol, answered by each light with its `devId`.
// Nothing here logs; a message never carries a secret into an error.
// -----------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, constants, publicEncrypt } from 'node:crypto';
import { CCT, CLOUD, DISCOVERY, LIMITS, LOCAL } from './constants.js';

/** An id of the cloud (device, user): letters, digits, `-`, `_` (never `.`, `:`, a control). */
export const isId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) && value.length <= LIMITS.idLength;

/**
 * The AES key of a light from its `aesKey` string, as python-aidot builds it: the bytes
 * zero-padded to 16; 24 or 32 bytes kept as they are; anything else is not a key.
 */
export function aesKeyOf(text) {
  if (typeof text !== 'string' || text === '') return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return undefined;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= 16) return Buffer.concat([bytes, Buffer.alloc(16 - bytes.length)]);
  if (bytes.length === 24 || bytes.length === 32) return bytes;
  return undefined;
}

const cipherName = (key) => `aes-${key.length * 8}-ecb`;

export function encrypt(plain, key) {
  const cipher = createCipheriv(cipherName(key), key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** Throws when the bytes do not open with `key` (another light, a changed key). */
export function decrypt(data, key) {
  const decipher = createDecipheriv(cipherName(key), key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** The key of the discovery protocol: its text zero-padded to 32 bytes (AES-256). */
export const DISCOVERY_KEY = Buffer.concat([
  Buffer.from(DISCOVERY.key, 'latin1'),
  Buffer.alloc(32 - DISCOVERY.key.length),
]);

/** A frame: magic, type, length, body. */
export function frameOf(type, body) {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(LOCAL.magic, 0);
  header.writeInt16BE(type, 2);
  header.writeInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** A message `object` of `type` in a frame, under `key`. */
export const encodeMessage = (object, key, type = LOCAL.MESSAGE) =>
  frameOf(type, encrypt(Buffer.from(JSON.stringify(object), 'utf8'), key));

/**
 * Reads the frames of a TCP stream: `push(chunk)` returns the complete frames `{ type, body }`;
 * throws on a wrong magic or a frame over `maxBytes` (before it is read whole).
 */
export function frameReader(maxBytes = LIMITS.frameBytes) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const frames = [];
      while (pending.length >= 8) {
        if (pending.readUInt16BE(0) !== LOCAL.magic) {
          throw Object.assign(new Error('not a frame'), { code: 'magic' });
        }
        const type = pending.readUInt16BE(2);
        const size = pending.readUInt32BE(4);
        if (size > maxBytes) throw Object.assign(new Error('frame too large'), { code: 'size' });
        if (pending.length < 8 + size) break;
        frames.push({ type, body: pending.subarray(8, 8 + size) });
        pending = pending.subarray(8 + size);
      }
      if (pending.length > maxBytes + 8) {
        throw Object.assign(new Error('frame too large'), { code: 'size' });
      }
      return frames;
    },
  };
}

/** A frame body opened with `key` and read as JSON; undefined when it does not open. */
export function openBody(body, key) {
  try {
    const value = JSON.parse(decrypt(body, key).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const pad = (n, size = 2) => String(n).padStart(size, '0');

/** `YYYY-MM-DD HH:MM:SS.ffffff` (local time), as python-aidot dates the loginReq. */
export function timestampOf(ms) {
  const d = new Date(ms);
  const micro = pad(Math.floor(ms % 1000) * 1000, 6);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${micro}`
  );
}

/** The loginReq of a connection (python-aidot `LoginRequest`). */
export function loginRequest({ seq, userId, deviceId, password, now }) {
  return {
    service: 'device',
    method: 'loginReq',
    seq,
    srcAddr: userId,
    deviceId,
    payload: { userId, password, timestamp: timestampOf(now), ascNumber: 1 },
  };
}

/**
 * A getDevAttrReq / setDevAttrReq (python-aidot `DeviceActionRequest.from_params`): the long
 * form for the lights the cloud gives a `simpleVersion`, the short form otherwise.
 */
export function actionRequest({
  method,
  userId,
  deviceId,
  password,
  ascNumber,
  attr,
  seq,
  simpleVersion,
  tst,
}) {
  const long = simpleVersion !== undefined && simpleVersion !== null;
  return {
    method,
    service: 'device',
    clientId: long ? `${LOCAL.clientPrefix}${userId}` : '',
    srcAddr: `0.${userId}`,
    seq,
    payload: {
      devId: long ? deviceId : '',
      parentId: long ? deviceId : '',
      userId: long ? userId : '',
      password: long ? password : '',
      attr,
      channel: 'tcp',
      ascNumber,
    },
    tst,
    deviceId,
  };
}

/** The heartbeat (python-aidot `PingRequest`), frame type 2. */
export const pingRequest = () => ({
  service: 'test',
  method: 'pingreq',
  seq: '123456',
  srcAddr: '123456',
  payload: {},
});

/** The `attr` of a setDevAttrReq for a target `{ power, dim, rgb, cct }` (only what is asked). */
export function attrOf(target) {
  const attr = {};
  if (target.dim !== undefined) attr.Dimming = target.dim;
  if (target.rgb !== undefined) attr.RGBW = rgbwOf(target.rgb);
  if (target.cct !== undefined) attr.CCT = target.cct;
  if (target.power !== undefined) attr.OnOff = target.power ? 1 : 0;
  return attr;
}

/** 0xRRGGBB -> RGBW packed r<<24|g<<16|b<<8|w (w = 0) as a signed int32, as python-aidot sends it. */
export const rgbwOf = (rgb) => ((rgb & 0xffffff) << 8) | 0;

/** RGBW (signed or not) -> 0xRRGGBB; undefined for 0 (python-aidot shows red for it: unknown). */
export function rgbOf(rgbw) {
  if (!Number.isInteger(rgbw) || rgbw < -0x80000000 || rgbw > 0xffffffff) return undefined;
  const value = rgbw >>> 0;
  if (value === 0) return undefined;
  return value >>> 8;
}

const int = (value) => {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d{1,10}$/.test(value)) return Number(value);
  return undefined;
};

/**
 * The attributes of a message, checked: `{ power?, dim?, rgb?, cct? }` with only what is valid;
 * undefined when nothing is. Out of range is unknown, never a value.
 */
export function stateOf(attr) {
  if (!attr || typeof attr !== 'object' || Array.isArray(attr)) return undefined;
  const state = {};
  const onOff = attr.OnOff === true ? 1 : attr.OnOff === false ? 0 : int(attr.OnOff);
  if (onOff === 0 || onOff === 1) state.power = onOff === 1;
  const dim = int(attr.Dimming);
  if (dim !== undefined && dim >= 0 && dim <= 100) state.dim = dim;
  const rgb = rgbOf(int(attr.RGBW));
  if (rgb !== undefined) state.rgb = rgb;
  const cct = int(attr.CCT);
  if (cct !== undefined && cct >= CCT.min && cct <= CCT.max) state.cct = cct;
  return Object.keys(state).length > 0 ? state : undefined;
}

/**
 * A message of a light, checked: `{ service, method, seq, deviceId, code, ascNumber, state }`.
 * Fields of the wrong type are left out.
 */
export function readMessage(json) {
  if (!json || typeof json !== 'object') return undefined;
  const text = (v, max = 64) => (typeof v === 'string' && v.length <= max ? v : undefined);
  const payload = json.payload && typeof json.payload === 'object' ? json.payload : {};
  const ack = json.ack && typeof json.ack === 'object' ? json.ack : {};
  const code = int(ack.code);
  const asc = int(payload.ascNumber);
  return {
    service: text(json.service),
    method: text(json.method),
    seq: text(json.seq),
    deviceId: text(json.deviceId) ?? text(payload.devId),
    code,
    ascNumber: asc !== undefined && asc >= 0 && asc < 2 ** 31 ? asc : undefined,
    state: stateOf(payload.attr),
  };
}

/** The devDiscoveryReq (python-aidot `DiscoverRequest`), in its AES-256 envelope. */
export function discoveryPayload({ userId, now }) {
  const ms = Math.floor(now);
  const message = {
    protocolVer: '2.0.0',
    service: 'device',
    method: 'devDiscoveryReq',
    seq: String(ms + 1).slice(-9),
    srcAddr: `0.${userId}`,
    tst: ms,
    payload: { extends: {}, localCtrFlag: 1, timestamp: String(ms) },
  };
  return encrypt(Buffer.from(JSON.stringify(message), 'utf8'), DISCOVERY_KEY);
}

/** A discovery answer: `{ id, mac }`; undefined when it is not one. */
export function readDiscovery(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 4096) return undefined;
  const json = openBody(bytes, DISCOVERY_KEY);
  const payload = json?.payload;
  if (!payload || typeof payload !== 'object' || !isId(payload.devId)) return undefined;
  return { id: payload.devId, mac: macOf(payload.mac) };
}

/** A MAC address normalized `aa:bb:cc:dd:ee:ff`; undefined when it is not one. */
export function macOf(value) {
  if (typeof value !== 'string') return undefined;
  const hex = value.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || /[^0-9a-f:-]/i.test(value)) return undefined;
  if (/^0+$/.test(hex) || /^f+$/.test(hex)) return undefined;
  return hex.match(/../g).join(':');
}

/** The password of the account under the public key of the library (RSA PKCS#1 v1.5), base64. */
export function sealPassword(password) {
  return publicEncrypt(
    { key: CLOUD.publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, 'utf8'),
  ).toString('base64');
}
