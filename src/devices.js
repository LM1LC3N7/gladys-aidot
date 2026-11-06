// -----------------------------------------------------------------------------
// An AiDot light -> its Gladys device (pure).
//
// `ext:<selector>:light:<id>`, `<id>` the id the AiDot cloud gives the device
// (the one the light answers with on the network): it follows the light
// whatever its address. Feature keys (frozen):
//   - `power`        light/binary 0-1 (every light): 0 = off;
//   - `brightness`   light/brightness 0-100 % (every light): 0 = off;
//   - `color`        light/color 0xRRGGBB (colour lights, `control.light.rgbw`);
//   - `temperature`  light/temperature in kelvin, the range of the product
//                    (white tunable lights: `control.light.cct`, and colour
//                    lights).
// A device published again never loses a feature: those of the device already
// created in Gladys are kept as they are, the new ones added.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { FEATURES as F } from './constants.js';
import { isId } from './protocol.js';
import { FEATURE_NAMES, deviceName, word } from './i18n.js';

export const KIND = 'light';
export const FEATURE_KEYS = Object.values(F);

/** The features of a light: power and brightness, colour and temperature when it has them. */
export function featureKeysOf(light) {
  const keys = [F.POWER, F.BRIGHTNESS];
  if (light.caps?.color) keys.push(F.COLOR);
  if (light.caps?.cct) keys.push(F.TEMPERATURE);
  return keys;
}

export function buildFeature(ids, key, language, light) {
  const base = {
    name: word(FEATURE_NAMES[key], language),
    external_id: ids.feature(key),
    category: C.LIGHT,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  };
  // No unit: the core lists none for the light category (DEVICE_FEATURE_UNITS_BY_CATEGORY).
  if (key === F.POWER) return { ...base, type: T.LIGHT.BINARY, min: 0, max: 1 };
  if (key === F.BRIGHTNESS) return { ...base, type: T.LIGHT.BRIGHTNESS, min: 0, max: 100 };
  if (key === F.COLOR) return { ...base, type: T.LIGHT.COLOR, min: 0, max: 0xffffff };
  if (key === F.TEMPERATURE) {
    // Kelvin: a range over 1000 is read as kelvin by the Gladys front.
    return { ...base, type: T.LIGHT.TEMPERATURE, min: light.caps.cct.min, max: light.caps.cct.max };
  }
  return undefined;
}

/**
 * The Gladys device of a light; `created`: the device as Gladys has it (its features kept,
 * the new ones added).
 */
export function buildDevice(gladys, light, { language, created } = {}) {
  const ids = gladys.externalIds(KIND, light.id);
  const features = [];
  const have = new Set();
  for (const feature of created?.features ?? []) {
    const key = featureKeyOf(feature.external_id, ids.device);
    if (key) {
      features.push(feature);
      have.add(key);
    }
  }
  for (const key of featureKeysOf(light)) {
    if (!have.has(key)) features.push(buildFeature(ids, key, language, light));
  }
  return {
    name: created?.name ?? deviceName(light, language),
    external_id: ids.device,
    model: light.modelId ? `AiDot ${light.modelId}`.slice(0, 60) : 'AiDot light',
    features,
    params: [],
  };
}

/** The feature key of an external id under a device id; undefined when not ours. */
export function featureKeyOf(externalId, deviceId) {
  if (typeof externalId !== 'string' || !externalId.startsWith(`${deviceId}:`)) return undefined;
  const key = externalId.slice(deviceId.length + 1);
  return FEATURE_KEYS.includes(key) ? key : undefined;
}

/** `ext:<selector>:light:<id>[:<key>]` -> `{ id, key }`; undefined when not one of ours. */
export function parseExternalId(externalId, selector) {
  const prefix = `ext:${selector}:${KIND}:`;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) return undefined;
  const [id, key, ...rest] = externalId.slice(prefix.length).split(':');
  if (!isId(id) || rest.length > 0) return undefined;
  if (key !== undefined && !FEATURE_KEYS.includes(key)) return undefined;
  return { id, key };
}

/** The states of a light for Gladys: `[[key, value]]`, only the known ones (never 0 for unknown). */
export function valuesOf(state) {
  const out = [];
  const { power, dim, rgb, cct } = state ?? {};
  if (typeof power === 'boolean') out.push([F.POWER, power ? 1 : 0]);
  if (Number.isInteger(dim)) out.push([F.BRIGHTNESS, dim]);
  if (Number.isInteger(rgb)) out.push([F.COLOR, rgb]);
  if (Number.isInteger(cct)) out.push([F.TEMPERATURE, cct]);
  return out;
}
