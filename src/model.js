// -----------------------------------------------------------------------------
// A device of the AiDot cloud -> a light of the integration (pure), as
// python-aidot 0.3.59 reads it (`device_client.py` DeviceInformation,
// `client.py`): only the lights (`type` "light") with a local key.
//   - `id`: the cloud id of the device, the id the light answers with on the
//     network (discovery `devId`, loginReq `deviceId`);
//   - `key`, `password`: the AES key and the password of the light (memory
//     only, never in /data, a log or the status);
//   - `ip`: its last address known by the cloud (a LAN address only);
//   - capabilities from its product: `control.light.rgbw` -> colour (and
//     white temperature), `control.light.cct` -> white temperature in the
//     range of the product (2700-6500 K without one).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { CCT, LIMITS } from './constants.js';
import { aesKeyOf, isId, macOf } from './protocol.js';

/** A name: text without control characters, trimmed, cut; undefined when empty. */
export function nameOf(value) {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text === '' ? undefined : text.slice(0, LIMITS.nameLength);
}

/**
 * An address of the local network the light may be reached at: private IPv4 (10/8,
 * 172.16/12, 192.168/16), link-local 169.254/16, shared 100.64/10, loopback; or a unique
 * local IPv6 (fc00::/7). Never "this network", a broadcast, a multicast, a public address.
 */
export function lanAddress(value) {
  if (typeof value !== 'string' || value.length > 45) return undefined;
  const text = value.trim();
  if (isIP(text) === 4) {
    const [a, b, c, d] = text.split('.').map(Number);
    if (d === 255 || (a === 0 && b === 0 && c === 0 && d === 0)) return undefined;
    const lan =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 127;
    return lan && d !== 0 ? text : undefined;
  }
  if (isIP(text) === 6 && /^f[cd][0-9a-f]{2}:/i.test(text)) return text.toLowerCase();
  return undefined;
}

const int = (value) => {
  const n = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) ? n : undefined;
};

/** The capabilities of a product: `{ known, color, cct: { min, max } | undefined }`. */
export function capabilitiesOf(product) {
  const modules = Array.isArray(product?.serviceModules) ? product.serviceModules : undefined;
  if (!modules) return { known: false, color: false, cct: undefined };
  let color = false;
  let cct;
  for (const module of modules.slice(0, 64)) {
    const identity = module?.identity;
    if (identity === 'control.light.rgbw') {
      color = true;
      cct ??= { min: CCT.defaultMin, max: CCT.defaultMax };
    } else if (identity === 'control.light.cct') {
      const range = Array.isArray(module.properties) ? module.properties[0] : undefined;
      const min = int(range?.minValue);
      const max = int(range?.maxValue);
      cct =
        min !== undefined && max !== undefined && min >= CCT.min && max <= CCT.max && min < max
          ? { min, max }
          : { min: CCT.defaultMin, max: CCT.defaultMax };
    }
  }
  return { known: true, color, cct };
}

/**
 * A raw device of the cloud -> `{ light }` or `{ skip }` (`not_light`, `no_key`, `bad_id`).
 * `light`: `{ id, name, mac, modelId, ip, key, password, simpleVersion, caps }`.
 */
export function lightOf(raw) {
  if (!raw || typeof raw !== 'object' || !isId(raw.id)) return { skip: 'bad_id' };
  if (String(raw.type ?? '').toLowerCase() !== 'light') return { skip: 'not_light' };
  const keyText = Array.isArray(raw.aesKey) ? raw.aesKey[0] : undefined;
  const key = aesKeyOf(keyText);
  if (!key) return { skip: 'no_key' };
  const password =
    typeof raw.password === 'string' && raw.password.length <= 256 ? raw.password : null;
  const simple =
    typeof raw.simpleVersion === 'string' && raw.simpleVersion.length <= 64
      ? raw.simpleVersion
      : undefined;
  return {
    light: {
      id: raw.id,
      name: nameOf(raw.name),
      mac: macOf(raw.mac),
      modelId: typeof raw.modelId === 'string' ? raw.modelId.slice(0, 64) : undefined,
      ip: lanAddress(raw.properties?.ipAddress),
      key,
      password,
      simpleVersion: simple,
      caps: capabilitiesOf(raw.product),
    },
  };
}
