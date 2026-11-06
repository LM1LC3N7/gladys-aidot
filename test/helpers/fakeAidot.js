// -----------------------------------------------------------------------------
// A fake AiDot world in memory, built from python-aidot 0.3.59 (MIT, Aidot
// Development Team): the cloud (sign-in, refresh, houses, devices, products,
// its error codes) behind the transport of src/cloud.js, and the lights on
// TCP port 10000 behind the `connect` of src/link.js (frames 1EED, AES-ECB
// with the key of each light, loginReq, getDevAttrReq, setDevAttrReq,
// heartbeat). Where python-aidot does not show the answers of a light, the
// fake answers `<method>Resp` with the same `seq` and `ack.code` 200, then
// pushes the new attributes. Its timers are those of the test clock.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { TransportError } from '../../src/http.js';
import {
  aesKeyOf,
  encodeMessage,
  frameReader,
  openBody,
  encrypt,
  DISCOVERY_KEY,
} from '../../src/protocol.js';

export const EMAIL = 'me@example.com';
export const PASSWORD = 'pa55-SECRET-word';
export const USER_ID = 'u5e7a1d0000000000000000000000001';
export const ACCESS = 'ACCESS-TOKEN-SECRET-1';
export const REFRESH = 'REFRESH-TOKEN-SECRET-1';
export const LAMP = '8a040e2233a243e7a07eb6a1b7a210a7';
export const BULB = '1b2c3d4e5f60718293a4b5c6d7e8f901';
export const KEY_LAMP = 'kEyLaMp0123456ab';
export const KEY_BULB = 'kEyBuLb0123456cd';
export const DEVICE_PASSWORD = 'devPASS-secret';

export const LIGHTS = () => [
  {
    id: LAMP,
    name: 'Living room',
    mac: 'AA:BB:CC:00:00:01',
    modelId: 'LK.light.A001855',
    productId: 'prodRGBW',
    ip: '192.168.1.50',
    key: KEY_LAMP,
    password: DEVICE_PASSWORD,
    simpleVersion: '1.0',
    state: { OnOff: 1, Dimming: 40, RGBW: 0xff000000 | 0, CCT: 3000 },
  },
  {
    id: BULB,
    name: 'Bedroom',
    mac: 'AA:BB:CC:00:00:02',
    modelId: 'LK.light.B002',
    productId: 'prodCCT',
    ip: '192.168.1.51',
    key: KEY_BULB,
    password: DEVICE_PASSWORD,
    state: { OnOff: 0, Dimming: 80, CCT: 4000 },
  },
];

export const PRODUCTS = [
  { id: 'prodRGBW', serviceModules: [{ identity: 'control.light.rgbw' }] },
  {
    id: 'prodCCT',
    serviceModules: [
      { identity: 'control.light.cct', properties: [{ minValue: 2700, maxValue: 6500 }] },
    ],
  },
];

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export function fakeAidot({ clock, lights = LIGHTS() } = {}) {
  const world = {
    clock,
    lights: new Map(lights.map((l) => [l.id, structuredClone(l)])),
    // --- the cloud
    cloud: {
      /** The account refuses the password (the fake cannot read it: RSA). */
      refuse: false,
      /** The sign-in answers 400 with another code (an account locked, say): never a refusal. */
      signInError: false,
      /** A status for every read of /houses (401: a session refused for ever). */
      housesStatus: undefined,
      requests: [],
      /** Latency of each answer (virtual ms). */
      latency: 10,
      /** The next answers: an array of (request) => answer | undefined (normal). */
      next: [],
      /** Every route answers 503 (count of them), or 429 with a Retry-After. */
      fail5xx: 0,
      rate: 0,
      retryAfter: undefined,
      /** The access token is expired (21026) / the session refused (21025) for the reads. */
      expired: false,
      invalid: false,
      /** The network is down: every request rejects. */
      down: false,
      productsFail: false,
      sessions: 0,
      signIns: 0,
    },
    // --- the lights
    refuse: new Set(),
    silent: new Set(),
    /** Lights answering without echoing the seq. */
    noSeq: new Set(),
    /** Lights that never answer a read (getDevAttrReq). */
    muteGet: new Set(),
    /** Lights that ignore a set entirely (no answer, nothing applied), reads answered. */
    muteSet: new Set(),
    /** Lights that answer a set but do not apply it. */
    ignoreSet: new Set(),
    /** Lights that apply a set without any push (the read shows it). */
    noPush: new Set(),
    latency: 15,
    /** Latency of the answers to reads only (undefined: `latency`). */
    getLatency: undefined,
    /** Latency of the answers to sets only; the answer to a set carries the state of before. */
    setLatency: undefined,
    answerAttr: false,
    /** A set applied and reported before its answer. */
    pushFirst: false,
    /** The light answers its login with another deviceId. */
    otherId: new Set(),
    pushDelay: 20,
    connectDelay: 5,
    connections: 0,
    open: 0,
    peak: 0,
    attempts: 0,
    /** Connections asked per address. */
    attemptsTo: {},
    sockets: new Set(),
    /** Every message received by a light: { at, id, type, message }. */
    received: [],
    later(fn, ms) {
      world.clock.timers.setTimeout(fn, ms);
    },
    /** Sets (attr) received by a light. */
    sets(id) {
      return world.received
        .filter((r) => r.id === id && r.message.method === 'setDevAttrReq')
        .map((r) => r.message.payload.attr);
    },
    gets(id) {
      return world.received.filter((r) => r.id === id && r.message.method === 'getDevAttrReq');
    },
    /** A change at the switch or in the app: the state, pushed to the open clients. */
    wall(id, attr) {
      const light = world.lights.get(id);
      Object.assign(light.state, attr);
      for (const socket of world.sockets) {
        if (socket.light === light && socket.logged) socket.feed(notifyOf(light));
      }
    },
    dropAll() {
      for (const socket of [...world.sockets]) socket.remoteClose();
    },
    transport: (url, options) => transport(world, url, options),
    connect: ({ host, port }) => openSocket(world, host, port),
    /** The discovery answers the core would relay. */
    discoveryReplies() {
      return [...world.lights.values()].map((l) => ({
        source_ip: l.ip,
        source_port: 6666,
        payload_base64: encrypt(
          Buffer.from(
            JSON.stringify({
              service: 'device',
              method: 'devDiscoveryResp',
              payload: { devId: l.id, mac: l.mac, ip: l.ip },
            }),
          ),
          DISCOVERY_KEY,
        ).toString('base64'),
      }));
    },
  };
  return world;
}

export const notifyOf = (light) => ({
  service: 'device',
  method: 'devAttrNotify',
  deviceId: light.id,
  payload: { devId: light.id, attr: { ...light.state }, ascNumber: 7 },
});

/** The cloud list as python-aidot reads it. */
export function rawDevices(world) {
  return [...world.lights.values()].map((l) => ({
    id: l.id,
    name: l.name,
    mac: l.mac,
    type: 'light',
    modelId: l.modelId,
    productId: l.productId,
    houseId: 'house1',
    aesKey: [l.key],
    password: l.password,
    ...(l.simpleVersion ? { simpleVersion: l.simpleVersion } : {}),
    properties: { ipAddress: l.ip },
  }));
}

async function transport(world, url, { method = 'GET', headers = {}, body } = {}) {
  const cloud = world.cloud;
  const at = world.clock.monotonic();
  const path = url.replace(/^https:\/\/prod-[a-z]+-api\.arnoo\.com\/v35/, '');
  const request = { at, url, path, method, headers, body: body ? JSON.parse(body) : undefined };
  cloud.requests.push(request);
  await new Promise((resolve) => world.clock.timers.setTimeout(resolve, cloud.latency));
  if (cloud.down) throw new TransportError('network', 'connection refused');
  const custom = cloud.next.shift()?.(request);
  if (custom) return custom;
  if (cloud.rate > 0) {
    cloud.rate -= 1;
    return json(
      429,
      { code: 429 },
      cloud.retryAfter ? { 'retry-after': String(cloud.retryAfter) } : {},
    );
  }
  if (cloud.fail5xx > 0) {
    cloud.fail5xx -= 1;
    return json(503, { desc: 'unavailable' });
  }
  if (headers.Appid !== '1383974540041977857' || headers.Terminal !== 'app')
    return json(400, { code: 1 });
  if (path === '/users/loginWithFreeVerification') {
    cloud.signIns += 1;
    if (cloud.signInError) return json(400, { code: 560099, desc: 'locked' });
    const b = request.body;
    if (b.username !== EMAIL || typeof b.password !== 'string' || b.password.length < 100)
      return json(400, { code: 560080, desc: 'wrong' });
    if (cloud.refuse) return json(400, { code: 560080, desc: 'wrong' });
    cloud.sessions += 1;
    cloud.expired = false;
    cloud.invalid = false;
    return json(200, { id: USER_ID, accessToken: ACCESS, refreshToken: REFRESH, username: EMAIL });
  }
  if (path === '/users/refreshToken') {
    if (request.body.refreshToken !== REFRESH) return json(400, { code: 21025 });
    cloud.expired = false;
    return json(200, { accessToken: ACCESS, refreshToken: REFRESH });
  }
  if (headers.Token !== ACCESS) return json(401, { code: 21025 });
  if (cloud.invalid) return json(400, { code: 21025 });
  if (cloud.expired) return json(400, { code: 21026 });
  if (path === '/houses' && cloud.housesStatus) return json(cloud.housesStatus, {});
  if (path === '/houses')
    return json(200, [
      { id: 'house1', isOwner: true },
      { id: 'house2', isOwner: false },
    ]);
  if (path === '/devices?houseId=house1') return json(200, rawDevices(world));
  if (path === '/devices?houseId=house2')
    return json(200, [{ id: 'foreign', type: 'light', aesKey: ['x'] }]);
  if (path.startsWith('/products/')) {
    if (cloud.productsFail) return json(404, { code: 404 });
    const ids = path.slice('/products/'.length).split(',');
    return json(
      200,
      PRODUCTS.filter((p) => ids.includes(p.id)),
    );
  }
  return json(404, { code: 404 });
}

function openSocket(world, host, port) {
  world.attempts += 1;
  world.attemptsTo[host] = (world.attemptsTo[host] ?? 0) + 1;
  const socket = new EventEmitter();
  socket.closed = false;
  socket.connected = false;
  socket.logged = false;
  socket.setNoDelay = () => {};
  const light = [...world.lights.values()].find((l) => l.ip === host);
  socket.light = light;
  const key = light ? aesKeyOf(light.key) : undefined;
  const reader = frameReader();
  socket.feed = (message, type = 1) => {
    if (socket.closed || !socket.connected) return;
    socket.emit('data', encodeMessage(message, key, type));
  };
  socket.feedRaw = (bytes) => {
    if (socket.closed || !socket.connected) return;
    socket.emit('data', Buffer.from(bytes));
  };
  const close = () => {
    if (socket.closed) return;
    socket.closed = true;
    if (world.sockets.delete(socket)) world.open -= 1;
    world.later(() => socket.emit('close'), 0);
  };
  socket.destroy = close;
  socket.end = close;
  socket.remoteClose = close;
  socket.write = (bytes) => {
    if (socket.closed) throw new Error('write after close');
    for (const frame of reader.push(Buffer.from(bytes))) {
      const message = openBody(frame.body, key);
      world.received.push({
        at: world.clock.monotonic(),
        id: light?.id,
        type: frame.type,
        message,
      });
      if (message) handle(world, socket, light, frame.type, message);
    }
    return true;
  };
  world.later(() => {
    if (socket.closed) return;
    if (!light || port !== 10000 || world.refuse.has(light.id)) {
      socket.closed = true;
      socket.emit(
        'error',
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
      return;
    }
    socket.connected = true;
    world.connections += 1;
    world.sockets.add(socket);
    world.open += 1;
    world.peak = Math.max(world.peak, world.open);
    socket.emit('connect');
  }, world.connectDelay);
  return socket;
}

function handle(world, socket, light, type, message) {
  if (world.silent.has(light.id)) return;
  const send = (fn, ms = world.latency) =>
    world.later(() => {
      if (!socket.closed) fn();
    }, ms);
  const seq = world.noSeq.has(light.id) ? undefined : message.seq;
  if (type === 2) {
    send(() => socket.feed({ service: 'test', method: 'pingresp', seq: message.seq }, 2));
    return;
  }
  if (message.method === 'loginReq') {
    const ok = message.payload?.password === light.password && message.payload?.userId === USER_ID;
    send(() => {
      socket.logged = ok;
      socket.feed({
        service: 'device',
        method: 'loginResp',
        seq,
        deviceId: world.otherId.has(light.id) ? 'someoneelse' : light.id,
        ack: { code: ok ? 200 : 401 },
        payload: { ascNumber: 5 },
      });
    });
    return;
  }
  if (!socket.logged) return;
  if (message.method === 'getDevAttrReq') {
    if (world.muteGet.has(light.id)) return;
    const snapshot = { ...light.state };
    send(
      () =>
        socket.feed({
          service: 'device',
          method: 'getDevAttrResp',
          seq,
          deviceId: light.id,
          ack: { code: 200 },
          payload: { devId: light.id, attr: snapshot, ascNumber: 6 },
        }),
      world.getLatency ?? world.latency,
    );
    return;
  }
  if (message.method === 'setDevAttrReq') {
    if (world.muteSet.has(light.id)) return;
    const before = { ...light.state };
    if (world.pushFirst) {
      // Applied and reported at once, answered later.
      Object.assign(light.state, message.payload.attr);
      for (const s of world.sockets) if (s.light === light && s.logged) s.feed(notifyOf(light));
    }
    send(() => {
      socket.feed({
        service: 'device',
        method: 'setDevAttrResp',
        seq,
        deviceId: light.id,
        ack: { code: 200 },
        // Some firmwares answer with the attributes as they were when the set came.
        ...(world.answerAttr ? { payload: { devId: light.id, attr: before } } : {}),
      });
      if (world.ignoreSet.has(light.id) || world.pushFirst) return;
      world.later(() => {
        const attr = message.payload.attr;
        if (attr.RGBW !== undefined) attr.RGBW = attr.RGBW | 0;
        Object.assign(light.state, attr);
        if (world.noPush.has(light.id)) return;
        for (const s of world.sockets) if (s.light === light && s.logged) s.feed(notifyOf(light));
      }, world.pushDelay);
    }, world.setLatency ?? world.latency);
  }
}
