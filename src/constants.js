// -----------------------------------------------------------------------------
// Constants: the AiDot cloud (sign-in, device list and keys), the local
// protocol of the lights, the feature keys, the limits and the timings.
//
// From python-aidot 0.3.59 (MIT, Aidot Development Team, the maker's own
// library, used by Home Assistant):
//   - cloud `https://prod-<region>-api.arnoo.com/v35`: POST
//     /users/loginWithFreeVerification (the password RSA-PKCS#1 v1.5 with the
//     public key of the library, base64), POST /users/refreshToken, GET
//     /houses, /devices?houseId=, /products/<ids>; headers `Appid` (the
//     application id of the library), `Terminal: app`, `Token` (the access
//     token). Errors in the JSON `code`: 560080 wrong e-mail or password,
//     21026 token expired, 21025 / 21027 / 21041 session no longer valid;
//   - each light on TCP port 10000: frames `1EED` (2 bytes), type (int16 BE:
//     1 message, 2 heartbeat), length (int32 BE), then the JSON body in
//     AES-ECB / PKCS#7 with the key the cloud gives for the light (`aesKey`);
//     `loginReq` first (user id, password of the light), then `getDevAttrReq`
//     and `setDevAttrReq` with `attr` {OnOff 0/1, Dimming 0-100, RGBW packed
//     r<<24|g<<16|b<<8|w as int32, CCT kelvin};
//   - discovery: `devDiscoveryReq` in UDP broadcast to port 6666, AES-256-ECB
//     with the fixed key of the protocol; each light answers its `devId`.
// -----------------------------------------------------------------------------

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const CLOUD = {
  /** `https://prod-<region>-api.arnoo.com/v35`, region us | eu | jp. */
  base: (region) => `https://prod-${region}-api.arnoo.com/v35`,
  /**
   * The application id of python-aidot (`aidot/login_const.py`), the maker's library: accepted by
   * Louis for this integration only (2026-11-05), see TODO.md and THIRD_PARTY_NOTICES.md.
   */
  appId: '1383974540041977857',
  /** The public key of python-aidot (`aidot/login_const.py`) the password is sent under. */
  publicKey: `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtQAnPCi8ksPnS1Du6z96PsKfN
p2Gp/f/bHwlrAdplbX3p7/TnGpnbJGkLq8uRxf6cw+vOthTsZjkPCF7CatRvRnTj
c9fcy7yE0oXa5TloYyXD6GkxgftBbN/movkJJGQCc7gFavuYoAdTRBOyQoXBtm0m
kXMSjXOldI/290b9BQIDAQAB
-----END PUBLIC KEY-----
`,
  /** The fields python-aidot sends with the sign-in, as it sends them. */
  webVersion: '0.5.0',
  area: 'Asia/Shanghai',
  utc: 'UTC+8',
};

/** Error codes of the cloud (the JSON `code`, python-aidot `const.py` and `client.py`). */
export const CLOUD_CODES = {
  WRONG_CREDENTIALS: 560080,
  TOKEN_EXPIRED: 21026,
  SESSION_INVALID: [21025, 21027, 21041],
};

export const LOCAL = {
  port: 10000,
  magic: 0x1eed,
  /** Frame types. */
  MESSAGE: 1,
  HEARTBEAT: 2,
  /** The light of the first generation answers no heartbeat: read instead, every 10 s. */
  firstGeneration: 'lk.WIFI-RGBWLight-D0006',
  firstGenerationAttrs: ['OnOff', 'Dimming', 'RGBW', 'CCT'],
  /** Our prefixes in `seq` and `clientId`, of the length of python-aidot's ("ha93", "ha-"). */
  seqPrefix: 'gl01',
  clientPrefix: 'gl-',
};

export const DISCOVERY = {
  port: 6666,
  /** The fixed key of the discovery protocol (python-aidot `discover.py`), 32 bytes. */
  key: 'T54uednca587',
  /** The core broadcasts at most 512 bytes. */
  maxPayload: 512,
};

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  /** light/binary 0-1: 0 = off. */
  POWER: 'power',
  /** light/brightness 0-100 %: 0 = off. */
  BRIGHTNESS: 'brightness',
  /** light/color 0xRRGGBB (colour lights). */
  COLOR: 'color',
  /** light/temperature in kelvin, the range of the light (white tunable lights). */
  TEMPERATURE: 'temperature',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The interval of the reads of each light (getDevAttrReq), in seconds; changes are pushed between. */
export const POLL_INTERVAL = { min: 30, max: 3600, default: 60 };

/** Colour temperature: the range of the cloud, bounded; without it 2700-6500 K (python-aidot). */
export const CCT = { min: 1000, max: 10000, defaultMin: 2700, defaultMax: 6500 };

export const LIMITS = {
  /** Lights of one account; more are ignored, said in the status. */
  devices: 128,
  houses: 20,
  /** One cloud answer at most (the list of devices with their products). */
  responseBytes: 2 * 1024 * 1024,
  /** One local frame at most (a message is ~500 bytes); a larger one closes the connection. */
  frameBytes: 16 * 1024,
  nameLength: 60,
  idLength: 64,
  /** Non-protective commands waiting, all lights. */
  commandQueue: 64,
  /** Offs kept in /data. */
  guards: 128,
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** Answers of a discovery broadcast read at most. */
  discoveryReplies: 256,
};

/** Priorities of the line of a light (one request in flight at a time). */
export const PRIORITY = { PROTECTIVE: 3, COMMAND: 2, READ: 1 };

export const TIMINGS = {
  /** A TCP connection is opened within this, or it failed. */
  connectTimeout: 2 * SECOND,
  /** The answer to the loginReq of a connection. */
  loginTimeout: 2 * SECOND,
  /** The answer (same `seq`) to a setDevAttrReq; without it the light is read. */
  answerTimeout: 1_200,
  /** The answer to a getDevAttrReq. */
  readTimeout: 2 * SECOND,
  /** A connection without traffic gets a heartbeat this often; 3 without a byte close it. */
  heartbeat: 30 * SECOND,
  heartbeatFirstGeneration: 10 * SECOND,
  heartbeatMisses: 3,
  /** After a connection that never logged in: 1 s before the next one, doubled up to 10 s. */
  reopenFirst: SECOND,
  reopenMax: 10 * SECOND,
  /** A request in flight with no byte for this long is cut when an Off waits. */
  stuck: SECOND,
  /** Failed connections of a light: new tries 5 s, 15 s, 30 s, 1, 2 then 5 min. */
  backoff: [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** Commands: the ack is given by 3.5 s after the click (Gladys waits 5 s). */
  commandAck: 3_500,
  /** A non-protective command not sent within this is dropped unsent. */
  commandMaxAge: 30 * SECOND,
  /** An Off is answered by this (4.3 s) after the click. */
  offAck: 4_300,
  /** An Off not sent at once is tried again during this budget. */
  protectiveRetry: 250,
  protectiveRetryGap: 50,
  /** A read of the light after a command whose effect was not seen. */
  followUp: 5 * SECOND,
  /** An Off held is sent again this often while not answered or not seen applied. */
  guardProbe: 10 * SECOND,
  /** An Off answered but still shown on is sent again this many times at most. */
  resendMax: 3,
  /** The cloud: one request answered within this. */
  cloudTimeout: 10 * SECOND,
  /** Two reads of the cloud list (any reason: start, Discover, test, restart) this far apart at least. */
  cloudGap: MINUTE,
  /** An Off held for a light whose key is not known: a pause of the cloud waited this long at most. */
  guardCloudPause: 10 * MINUTE,
  /** The cloud list (names, addresses, keys) read again this often. */
  cloudRefresh: 6 * HOUR,
  /** A cloud read that failed (network, unreadable answer): new tries 1, 2, 5, 15, 30, then 60 min. */
  cloudRetry: [MINUTE, 2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR],
  /** 429 / 5xx of the cloud: a pause of 60 s doubled up to 6 h (or its Retry-After, bounded). */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** Discovery through the core: answers awaited this long; automatic ones this far apart. */
  discoverySeconds: 3,
  discoveryGap: 5 * MINUTE,
  /** "Test the connection" signs in at most this often. */
  testCooldown: 10 * SECOND,
  /** The configuration of Gladys not read: new tries 5 s, 15 s, then every minute. */
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE],
  configAskGap: 2 * SECOND,
  configWait: 3 * SECOND,
  /** A read or a save of /data is waited for this long at most (never a wait that holds an Off). */
  storeWait: 1_500,
  /** /data unreadable at start: read again on a timer of its own. */
  storeRetry: 10 * SECOND,
};
