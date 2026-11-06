// -----------------------------------------------------------------------------
// The cloud client against the fake cloud: the sign-in as python-aidot sends
// it, the one refusal (code 560080 of the sign-in), the renewals that are
// never a refusal (21026 refresh, 21025 / 401 a new sign-in), 429 / 5xx with
// their Retry-After, a secondary route (products) never blocking, bounded
// answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudClient, CloudError } from '../src/cloud.js';
import { countryOf } from '../src/countries.js';
import { testClock } from './kit/index.mjs';
import { ACCESS, EMAIL, LAMP, PASSWORD, fakeAidot } from './helpers/fakeAidot.js';

function client(world, { password = PASSWORD, country = 'FR' } = {}) {
  return new CloudClient({
    transport: world.transport,
    account: { email: EMAIL, password, country: countryOf(country) },
    terminalId: 'f'.repeat(32),
  });
}

/** Runs `fn` while the virtual clock moves (the fake cloud answers on it). */
async function run(clock, fn) {
  let done = false;
  const result = fn().then(
    (value) => ((done = true), { value }),
    (error) => ((done = true), { error }),
  );
  for (let i = 0; i < 2000 && !done; i += 1) await clock.advance(10);
  const { value, error } = await result;
  if (error) throw error;
  return value;
}

test('the sign-in: region of the country, headers and body of python-aidot, the password never as is', async () => {
  const clock = testClock();
  const world = fakeAidot({ clock });
  const c = client(world);
  const { devices, productsRead } = await run(clock, () => c.readDevices());
  assert.equal(devices.length, 2, 'the house of another owner is skipped');
  assert.ok(productsRead);
  assert.equal(devices.find((d) => d.id === LAMP).product.id, 'prodRGBW');
  const login = world.cloud.requests[0];
  assert.equal(login.url, 'https://prod-eu-api.arnoo.com/v35/users/loginWithFreeVerification');
  assert.equal(login.headers.Appid, '1383974540041977857');
  assert.equal(login.headers.Terminal, 'app');
  assert.equal(login.headers['User-Agent'], undefined, 'no imitation of the app');
  assert.equal(login.body.countryKey, 'region:France');
  assert.equal(login.body.username, EMAIL);
  assert.notEqual(login.body.password, PASSWORD);
  assert.ok(!JSON.stringify(world.cloud.requests).includes(PASSWORD));
  assert.equal(login.body.terminalId, 'f'.repeat(32));
  assert.equal(world.cloud.requests[1].headers.Token, ACCESS);
  const us = client(fakeAidot({ clock }), { country: 'US' });
  assert.equal(us.base, 'https://prod-us-api.arnoo.com/v35');
});

test('wrong e-mail or password (560080 of the sign-in): the one refusal', async () => {
  const clock = testClock();
  const world = fakeAidot({ clock });
  world.cloud.refuse = true;
  const c = client(world, { password: 'wrong' });
  await assert.rejects(
    run(clock, () => c.readDevices()),
    (err) => err instanceof CloudError && err.kind === 'refused',
  );
  assert.equal(c.signIns, 1);
});

test('an expired token is refreshed; a session refused gets one new sign-in; never a refusal', async () => {
  const clock = testClock();
  const world = fakeAidot({ clock });
  const c = client(world);
  await run(clock, () => c.readDevices());
  world.cloud.expired = true;
  await run(clock, () => c.readDevices());
  assert.equal(c.signIns, 1, 'refreshed, no new sign-in');
  assert.ok(world.cloud.requests.some((r) => r.path === '/users/refreshToken'));
  world.cloud.invalid = true;
  await run(clock, () => c.readDevices());
  assert.equal(c.signIns, 2);
  // A 401 for ever on a read: one new sign-in, then "session", never "refused".
  world.cloud.housesStatus = 401;
  await assert.rejects(
    run(clock, () => c.readDevices()),
    (err) => err instanceof CloudError && ['session', 'denied'].includes(err.kind),
  );
  assert.equal(c.signIns, 3, 'one new sign-in, no loop');
});

test('without leave to sign in, an expired session is "session", never a sign-in', async () => {
  const clock = testClock();
  const world = fakeAidot({ clock });
  const c = client(world);
  await assert.rejects(
    run(clock, () => c.readDevices({ maySignIn: false })),
    (err) => err.kind === 'session',
  );
  assert.equal(world.cloud.requests.length, 0);
});

test('429 and 5xx with their Retry-After (seconds, or a date against the Date of the answer)', async () => {
  const clock = testClock();
  const world = fakeAidot({ clock });
  const c = client(world);
  world.cloud.rate = 1;
  world.cloud.retryAfter = 120;
  await assert.rejects(
    run(clock, () => c.readDevices()),
    (err) => err.kind === 'rate' && err.retryAfter === 120_000,
  );
  world.cloud.next.push(() => ({
    status: 503,
    headers: {
      date: 'Thu, 05 Nov 2026 12:00:00 GMT',
      'retry-after': 'Thu, 05 Nov 2026 12:05:00 GMT',
    },
    body: '',
  }));
  await assert.rejects(
    run(clock, () => c.readDevices()),
    (err) => err.kind === 'unavailable' && err.retryAfter === 300_000,
  );
  world.cloud.next.push(() => ({
    status: 503,
    headers: { 'retry-after': 'Thu, 05 Nov 2026 12:05:00 GMT' },
    body: '',
  }));
  await assert.rejects(
    run(clock, () => c.readDevices()),
    (err) => err.kind === 'unavailable' && err.retryAfter === undefined,
  );
});

test('the products (secondary) failing never stops the list; an unreadable answer is bad_response', async () => {
  const clock = testClock();
  const world = fakeAidot({ clock });
  const c = client(world);
  world.cloud.productsFail = true;
  const res = await run(clock, () => c.readDevices());
  assert.equal(res.devices.length, 2);
  assert.equal(res.productsRead, false);
  world.cloud.next.push((r) =>
    r.path === '/houses' ? { status: 200, headers: {}, body: '<html>' } : undefined,
  );
  await assert.rejects(
    run(clock, () => c.readDevices()),
    (err) => err.kind === 'bad_response',
  );
  world.cloud.next.push(() => ({ status: 200, headers: {}, body: 'x'.repeat(3 * 1024 * 1024) }));
  await assert.rejects(
    run(clock, () => c.readDevices()),
    (err) => err.kind === 'size',
  );
  world.cloud.down = true;
  await assert.rejects(
    run(clock, () => c.readDevices()),
    (err) => err.kind === 'network',
  );
});
