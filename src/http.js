// -----------------------------------------------------------------------------
// The only HTTPS access (the AiDot cloud): one request, its body read bounded
// in size and time, the promise settled once, nothing of the request (the
// password, the token) ever put in an error. Tests replace it by a transport
// of their own (src/cloud.js).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { LIMITS, TIMINGS } from './constants.js';

/** A failed transport: `code` network | timeout | size; `detail` a short, secret-free reason. */
export class TransportError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TransportError';
    this.code = code;
    this.detail = detail;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
  CERT_HAS_EXPIRED: 'certificate expired',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate not trusted',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certificate not trusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certificate of another host',
};

/**
 * One HTTPS request: resolves `{ status, headers, body }` whatever the status (the body as
 * text, `maxBytes` at most), rejects with a TransportError. TLS is checked by Node (the
 * certificates of the system), never turned off.
 */
export function httpsRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeout = TIMINGS.cloudTimeout,
    maxBytes = LIMITS.responseBytes,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    let req;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    try {
      const target = new URL(url);
      // The cloud is https only (src/constants.js); plain http serves the tests of the bounds.
      const lib = target.protocol === 'http:' ? http : https;
      req = lib.request(target, { method, headers }, (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          settle(reject, new TransportError('size', 'answer too large'));
          req.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            settle(reject, new TransportError('size', 'answer too large'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          settle(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) =>
          settle(reject, new TransportError('network', NETWORK_REASONS[err?.code] ?? 'error')),
        );
      });
    } catch {
      settle(reject, new TransportError('network', 'invalid request'));
      return;
    }
    timer = setTimeout(
      () => {
        settle(reject, new TransportError('timeout', 'no answer in time'));
        req.destroy();
      },
      Math.max(1, timeout),
    );
    req.on('error', (err) =>
      settle(reject, new TransportError('network', NETWORK_REASONS[err?.code] ?? 'error')),
    );
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> ms; undefined when absent or unreadable. */
export function parseRetryAfter(value, now) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
