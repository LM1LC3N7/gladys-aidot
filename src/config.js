// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized: the e-mail
// and the password of the AiDot account (the app's), its country (it picks
// the region of the cloud), the interval of the reads of the lights and the
// language of the feature names.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { DEFAULT_COUNTRY, countryOf } from './countries.js';
import { POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  country: 'FR',
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const number = (value) =>
  value === undefined || value === null || value === '' ? NaN : Number(value);

const clamp = (value, { min, max }, fallback) =>
  Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;

/**
 * `{ email, password, country, pollInterval, language, error }`. `error`: `no_email` (a password
 * without an e-mail), `no_password`, `bad_email`, `bad_password` (a control character), or
 * undefined. The credentials are usable only without an error.
 */
export function normalizeConfig(raw = {}) {
  const email = typeof raw?.email === 'string' ? raw.email.trim() : '';
  const password = typeof raw?.password === 'string' ? raw.password : '';
  const code = String(raw?.country ?? DEFAULTS.country)
    .trim()
    .toUpperCase();
  const country = countryOf(code) ?? countryOf(DEFAULTS.country) ?? countryOf(DEFAULT_COUNTRY);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  let error;
  if (email === '' && password === '') error = 'no_credentials';
  else if (email === '') error = 'no_email';
  else if (password === '') error = 'no_password';
  else if (email.length > 254 || CONTROL.test(email) || !/^[^@\s]+@[^@\s]+$/.test(email))
    error = 'bad_email';
  else if (password.length > 128 || /[\r\n]/.test(password) || password.includes('\u0000'))
    error = 'bad_password';
  return {
    email,
    password,
    country,
    countryError: countryOf(code) === undefined,
    pollInterval: clamp(number(raw?.poll_interval), POLL_INTERVAL, DEFAULTS.poll_interval),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
    error,
  };
}

/** True when two configurations name other credentials (e-mail, password or country). */
export const credentialsChanged = (a, b) =>
  a.email !== b.email || a.password !== b.password || a.country.code !== b.country.code;

/** The account in /data: a salted fingerprint of the e-mail (case ignored) and the country. */
export const accountKeyOf = (config, salt) =>
  createHash('sha256')
    .update(`${salt}\u0000account\u0000${config.email.toLowerCase()}\u0000${config.country.code}`)
    .digest('hex')
    .slice(0, 16);

/**
 * A mark of a REFUSED password for /data: 6 bits of a salted fingerprint (64 values), so
 * nothing in /data narrows the password down; only a refused password is ever marked.
 */
export const passwordMarkOf = (password, salt) =>
  createHash('sha256').update(`${salt}\u0000refused\u0000${password}`).digest()[0] & 0x3f;
