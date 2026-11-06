// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), sped
// up 20 times, against a real local TCP server playing an AiDot light (frames,
// AES, login, reads, sets) and the fake cloud: the reads of the light come at
// the interval (measured), never sooner; a command and an Off confirmed on a
// real socket. Every wait is bounded; the app, the clock and the server are
// stopped in t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { tcpConnect } from '../src/link.js';
import { aesKeyOf, encodeMessage, frameReader, openBody } from '../src/protocol.js';
import { memoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn, tcpServer } from './kit/index.mjs';
import { CONFIG, F, created } from './helpers/app.js';
import { LAMP, LIGHTS, USER_ID, fakeAidot } from './helpers/fakeAidot.js';

const SPEED = 20;
const INTERVAL = 30_000;

async function lightServer(light) {
  const key = aesKeyOf(light.key);
  const readers = new Map();
  const srv = await tcpServer({
    latencyMs: 2,
    onData: (chunk, conn) => {
      if (!readers.has(conn.id)) readers.set(conn.id, frameReader());
      const out = [];
      for (const frame of readers.get(conn.id).push(chunk)) {
        const m = openBody(frame.body, key);
        if (!m) continue;
        const answer = (extra) =>
          out.push(
            encodeMessage(
              { service: 'device', seq: m.seq, deviceId: light.id, ack: { code: 200 }, ...extra },
              key,
            ),
          );
        if (frame.type === 2)
          out.push(encodeMessage({ service: 'test', method: 'pingresp' }, key, 2));
        else if (m.method === 'loginReq')
          answer({
            method: 'loginResp',
            ack: { code: m.payload.userId === USER_ID ? 200 : 401 },
            payload: { ascNumber: 3 },
          });
        else if (m.method === 'getDevAttrReq')
          answer({ method: 'getDevAttrResp', payload: { attr: { ...light.state } } });
        else if (m.method === 'setDevAttrReq') {
          Object.assign(light.state, m.payload.attr);
          answer({ method: 'setDevAttrResp', payload: { attr: { ...light.state } } });
        }
      }
      return out.length ? Buffer.concat(out) : undefined;
    },
  });
  return srv;
}

test('real clock x20: reads at the interval, a command and an Off confirmed on a real socket', async (t) => {
  const clock = realClock({ speed: SPEED });
  const world = fakeAidot({ clock, lights: [{ ...LIGHTS()[0], ip: '192.168.1.50' }] });
  world.cloud.latency = 20;
  const light = world.lights.get(LAMP);
  const srv = await lightServer(light);
  const gladys = createFakeGladys({
    selector: 'aidot',
    config: { ...CONFIG, poll_interval: INTERVAL / 1000 },
    devices: [created(LAMP)],
  });
  await gladys.connect();
  const quiet = () => {};
  const app = new App({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    // The light's LAN address, served by the local server.
    connect: () => tcpConnect({ host: '127.0.0.1', port: srv.port }),
    transport: world.transport,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  registerHandlers(gladys, app);
  t.after(async () => {
    app.stop();
    clock.close();
    await srv.close();
  });
  const spy = spyOn(app, 'readLight', clock);
  await app.onConnected(() => gladys.getConfig());
  // The first read is the one at connection; the next ones at the interval.
  await measurePeriod(spy, { count: 4, period: INTERVAL, timeoutMs: 15_000 });
  const gaps = spy.calls.slice(1, 4).map((c, i) => c.at - spy.calls[i].at);
  assert.ok(
    gaps.every((g) => g >= INTERVAL * 0.9),
    `never sooner: ${gaps}`,
  );
  const device = gladys.fake.devices[0];
  const withTimeout = (p) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no ack')), 5000)),
    ]);
  assert.deepEqual(
    await withTimeout(gladys.fake.setValue(device, { external_id: F(LAMP, 'brightness') }, 33)),
    {
      success: true,
    },
  );
  assert.equal(light.state.Dimming, 33);
  assert.deepEqual(
    await withTimeout(gladys.fake.setValue(device, { external_id: F(LAMP, 'power') }, 0)),
    {
      success: true,
    },
  );
  assert.equal(light.state.OnOff, 0);
  assert.equal(srv.peak, 1, 'one connection at a time');
});
