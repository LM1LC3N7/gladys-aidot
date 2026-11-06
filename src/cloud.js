// -----------------------------------------------------------------------------
// The AiDot cloud, ported from python-aidot 0.3.59 (`client.py`, MIT, Aidot
// Development Team): the sign-in (e-mail, password, country), the tokens it
// gives (kept in memory only), and the reads of the houses, the devices and
// their products, which bring the name, the model, the address and the keys
// of each light. Nothing is commanded through the cloud: the lights are
// driven on the local network (src/link.js).
//
// - Only the sign-in route says "wrong e-mail or password" (code 560080):
//   that is the one refusal of the credentials. A 401/403 or a session error
//   of another route is never one: the session is renewed (refresh token,
//   then one sign-in), and the read fails as "not read" if that is not enough.
// - 429 and 5xx: `rate` / `unavailable`, with the Retry-After when given
//   (seconds, or a date compared to the Date header of the same answer).
// - Every answer is bounded (src/http.js); the JSON is checked, never trusted.
// - Never in a log, an error or the status: the password, a token, the user
//   id, a key of a light.
// -----------------------------------------------------------------------------

import { CLOUD, CLOUD_CODES, LIMITS } from './constants.js';
import { TransportError, httpsRequest, parseRetryAfter } from './http.js';
import { isId, sealPassword } from './protocol.js';

/**
 * A failed cloud call. `kind`:
 * - `refused`: the sign-in refused the e-mail or the password (code 560080);
 * - `session`: the session was not accepted even after a renewal (never a refusal);
 * - `denied`: 401/403 of a read route (never a refusal);
 * - `rate` (429), `unavailable` (5xx): `retryAfter` in ms when given;
 * - `network`, `timeout`, `size`: the transport; `bad_response`: not the expected answer;
 * - `http`: any other status.
 */
export class CloudError extends Error {
  constructor(kind, { status, code, retryAfter, detail } = {}) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'CloudError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const codeOf = (json) => {
  const code = Number(json?.code);
  return Number.isInteger(code) ? code : undefined;
};

/** The JSON of a body; `bad_response` when it is not JSON. */
function jsonOf(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new CloudError('bad_response', { detail: 'not JSON' });
  }
}

/** The 429 / 5xx of an answer, with its Retry-After (a date: against the Date of the answer). */
function transientOf({ status, headers = {} }) {
  if (status !== 429 && !(status >= 500)) return undefined;
  const serverNow = Date.parse(headers.date ?? '');
  const raw = headers['retry-after'];
  const retryAfter =
    raw !== undefined && /^\s*\d{1,9}\s*$/.test(String(raw))
      ? parseRetryAfter(String(raw).trim(), 0)
      : Number.isNaN(serverNow)
        ? undefined
        : parseRetryAfter(raw, serverNow);
  return new CloudError(status === 429 ? 'rate' : 'unavailable', { status, retryAfter });
}

export class CloudClient {
  /**
   * `transport(url, { method, headers, body })` -> `{ status, headers, body }` (src/http.js by
   * default). `account`: `{ email, password, country: { name, region } }`. `terminalId`: the id
   * of this installation sent at sign-in.
   */
  constructor({ transport = httpsRequest, account, terminalId }) {
    this.transport = transport;
    this.account = account;
    this.terminalId = terminalId;
    this.base = CLOUD.base(account.country.region);
    /** `{ userId, accessToken, refreshToken }` once signed in (memory only). */
    this.session = undefined;
    /** Sign-ins posted by this client (the password sent). */
    this.signIns = 0;
  }

  get signedIn() {
    return this.session !== undefined;
  }

  get userId() {
    return this.session?.userId;
  }

  async send(path, { method = 'GET', body, token } = {}) {
    const headers = { Appid: CLOUD.appId, Terminal: 'app', Accept: 'application/json' };
    if (token) headers.Token = token;
    let text;
    if (body !== undefined) {
      text = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(text));
    }
    let answer;
    try {
      answer = await this.transport(`${this.base}${path}`, { method, headers, body: text });
    } catch (err) {
      if (err instanceof TransportError) throw new CloudError(err.code, { detail: err.detail });
      throw new CloudError('network', { detail: 'error' });
    }
    if (!answer || !Number.isInteger(answer.status)) {
      throw new CloudError('bad_response', { detail: 'no status' });
    }
    if (typeof answer.body === 'string' && Buffer.byteLength(answer.body) > LIMITS.responseBytes) {
      throw new CloudError('size', { detail: 'answer too large' });
    }
    const transient = transientOf(answer);
    if (transient) throw transient;
    let json;
    try {
      json = jsonOf(answer.body ?? '');
    } catch (err) {
      if (answer.status >= 200 && answer.status < 300) throw err;
      json = undefined;
    }
    return { status: answer.status, json };
  }

  /**
   * The sign-in (python-aidot `async_post_login`): the only call that posts the password. The
   * app calls it only when it may (never while the credentials are refused, but on a click or
   * new credentials).
   */
  async signIn() {
    const { email, password, country } = this.account;
    this.signIns += 1;
    const { status, json } = await this.send('/users/loginWithFreeVerification', {
      method: 'POST',
      body: {
        countryKey: `region:${country.name.trim()}`,
        username: email,
        password: sealPassword(password),
        terminalId: this.terminalId,
        webVersion: CLOUD.webVersion,
        area: CLOUD.area,
        UTC: CLOUD.utc,
      },
    });
    const code = codeOf(json);
    if (code === CLOUD_CODES.WRONG_CREDENTIALS) throw new CloudError('refused', { status, code });
    if (status < 200 || status >= 300) throw new CloudError('http', { status, code });
    const session = {
      userId: json?.id,
      accessToken: json?.accessToken,
      refreshToken: json?.refreshToken,
    };
    if (
      !isId(session.userId) ||
      typeof session.accessToken !== 'string' ||
      session.accessToken === '' ||
      session.accessToken.length > 4096
    ) {
      throw new CloudError('bad_response', { status, detail: 'no session in the answer' });
    }
    if (typeof session.refreshToken !== 'string' || session.refreshToken.length > 4096) {
      session.refreshToken = undefined;
    }
    this.session = session;
    return session;
  }

  /** The refresh token for a new access token (python-aidot `async_refresh_token`); false when refused. */
  async refresh() {
    const refreshToken = this.session?.refreshToken;
    if (!refreshToken) return false;
    let answer;
    try {
      answer = await this.send('/users/refreshToken', {
        method: 'POST',
        body: { refreshToken },
      });
    } catch (err) {
      if (err instanceof CloudError && err.kind === 'bad_response') return false;
      throw err;
    }
    const { status, json } = answer;
    if (status < 200 || status >= 300 || typeof json?.accessToken !== 'string' || !json.accessToken)
      return false;
    if (json.accessToken.length > 4096) return false;
    this.session.accessToken = json.accessToken;
    if (
      typeof json.refreshToken === 'string' &&
      json.refreshToken &&
      json.refreshToken.length <= 4096
    )
      this.session.refreshToken = json.refreshToken;
    return true;
  }

  /**
   * A read with the session: an expired token is refreshed, a session refused is renewed by
   * one sign-in (`maySignIn`), then the read is tried once more. Never a refusal of the
   * credentials but from the sign-in itself.
   */
  async get(path, { maySignIn = true } = {}) {
    let renewed = false;
    for (;;) {
      if (!this.session) {
        if (!maySignIn || renewed) throw new CloudError('session', { detail: 'not signed in' });
        renewed = true;
        await this.signIn();
      }
      const { status, json } = await this.send(path, { token: this.session.accessToken });
      if (status >= 200 && status < 300) return json;
      const code = codeOf(json);
      if (renewed) {
        throw new CloudError(status === 401 || status === 403 ? 'denied' : 'session', {
          status,
          code,
        });
      }
      if (code === CLOUD_CODES.TOKEN_EXPIRED && (await this.refresh())) {
        const again = await this.send(path, { token: this.session.accessToken });
        if (again.status >= 200 && again.status < 300) return again.json;
        throw new CloudError('session', { status: again.status, code: codeOf(again.json) });
      }
      if (
        code === CLOUD_CODES.TOKEN_EXPIRED ||
        CLOUD_CODES.SESSION_INVALID.includes(code) ||
        status === 401
      ) {
        // The session is no longer accepted: one new sign-in, then the read once more.
        this.session = undefined;
        if (!maySignIn) throw new CloudError('session', { status, code });
        continue;
      }
      if (status === 403) throw new CloudError('denied', { status, code });
      throw new CloudError('http', { status, code });
    }
  }

  /**
   * The devices of the houses the account owns, each with its product (python-aidot
   * `async_get_all_device`): `{ devices: [...raw] , houses }`, bounded.
   */
  async readDevices({ maySignIn = true } = {}) {
    const houses = await this.get('/houses', { maySignIn });
    if (!Array.isArray(houses)) throw new CloudError('bad_response', { detail: 'houses' });
    const devices = [];
    for (const house of houses.slice(0, LIMITS.houses)) {
      if (!plain(house) || house.isOwner === false || !isId(house.id)) continue;
      const list = await this.get(`/devices?houseId=${encodeURIComponent(house.id)}`, {
        maySignIn,
      });
      if (!Array.isArray(list)) throw new CloudError('bad_response', { detail: 'devices' });
      for (const device of list) {
        if (devices.length >= LIMITS.devices * 2) break;
        if (plain(device)) devices.push(device);
      }
    }
    const productIds = [...new Set(devices.map((d) => d.productId).filter((id) => isId(id)))].slice(
      0,
      LIMITS.devices,
    );
    let productsRead = productIds.length === 0;
    if (productIds.length > 0) {
      let products;
      try {
        products = await this.get(`/products/${productIds.join(',')}`, { maySignIn });
      } catch (err) {
        // A secondary route: its failure never stops the list (the capabilities read before
        // stay); a pause or a refusal still ends the read.
        if (!(err instanceof CloudError) || ['rate', 'unavailable', 'refused'].includes(err.kind))
          throw err;
      }
      if (Array.isArray(products)) {
        productsRead = true;
        const byId = new Map();
        for (const product of products)
          if (plain(product) && isId(product.id)) byId.set(product.id, product);
        for (const device of devices) {
          const product = byId.get(device.productId);
          if (product) device.product = product;
        }
      }
    }
    return { devices, productsRead };
  }
}
