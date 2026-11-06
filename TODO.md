# TODO - AiDot v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1** (2026-11-06): the AiDot cloud (sign-in, houses, devices,
      products) for the list, addresses and keys of the lights; each light added
      driven on the local network (TCP 10000, AES): power, brightness, colour,
      colour temperature, pushes shown at once, a read every interval; Offs
      protective (guards in `/data`); refusal of the credentials kept, 429 / 5xx
      pause; discovery through the Gladys core; Discover; "Test the
      connection"; fr/en docs. Tested against a fake cloud and fake lights on a
      virtual clock (built from python-aidot 0.3.59) and a real local TCP light
      on a real clock (x20). Never tested with a real device or account.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- Reference: python-aidot 0.3.59 (MIT, Aidot Development Team, the maker; last
  commit 0df6e4d, 2026-09-30); licence read in its `LICENSE`; ported to
  JavaScript, notice in `THIRD_PARTY_NOTICES.md`, shipped in the image.
- **Application id of the maker's library**: the sign-in sends the `Appid`
  `1383974540041977857` of python-aidot (`aidot/login_const.py`), with its
  `Terminal: app` header and the fields `webVersion`, `area`, `UTC` it sends.
  Imitating an application needs Louis's approval: **Louis accepted it for
  this integration only on 2026-11-05** ("Ok pour ce lot, avec aidot car c'est
  la lib officielle"). Said in the docs (fr/en), README and
  THIRD_PARTY_NOTICES.md. No other imitation: no User-Agent; our own `seq`
  prefix (`gl01`) and `clientId` prefix (`gladys-`) instead of the "ha" ones of
  the library (untested on a real light: if a light refuses them, that is the
  first thing to check).
- The cloud gives the keys: they stay in memory (never in `/data`), so after a
  restart an Off held waits for the first read of the cloud (a minute after the
  last attempt at most) before it can leave. Said in the docs.
- Only the sign-in route refuses the credentials (code 560080). A 401 or a
  session code (21025/21027/21041) of a read renews the session (one sign-in)
  and is never a refusal; 21026 refreshes the token. A refusal is kept in
  `/data` (salted fingerprint of e-mail + country, 6-bit mark of the password)
  and nothing is posted again by itself; new credentials saved or the test
  button try again.
- Cloud pace: a minute between two reads (start, restart, Discover, the 6 h
  refresh, a retry), but new credentials saved and the test button (10 s apart); a read every 6 h; failures 1, 2,
  5, 15, 30, 60 min; 429 / 5xx pause 60 s doubled up to 6 h (Retry-After
  bounded, a date compared to the Date of the same answer), in `/data`.
- The products route is secondary: its failure (but 429 / 5xx) never stops the
  list; the capabilities read before stay.
- Only the lights added in Gladys (or with an Off held) are connected.
- Addresses: from the cloud (`properties.ipAddress`), else from the discovery
  through the core (`scanNetwork('udp-active-broadcast', port 6666)`, at
  Discover and when a light cannot be reached, 5 min apart); only addresses of
  the local network (private, link-local, shared, loopback, IPv6 ULA); a MAC of
  the discovery that differs from the cloud's is another light.
- Identity: each light answers its login only with its own key and id; a frame
  that does not open with the key, another `deviceId` or no answer to the login
  asks the cloud again (new key) and a discovery (new address).
- Confirmation: done when a state after the send shows the target and the light
  answered the set (same `seq`, or its `...Resp`) or the state changed from
  before; otherwise "sent, without confirmation" / "shows another state" and a
  read 5 s later. Brightness, colour and temperature also send `OnOff: 1`
  (always, not only when the light is believed off as in python-aidot).
- Offs: as gladys-deako 0.1.1 (approved at r4): no deadline to leave, cut of a
  request silent 1 s, kept and sent every 10 s while unanswered (never given
  up), judged by a read right after each send, 4 answered tries at most; a
  push "on" after the answer ends the guard (turned on elsewhere).
- Features: light/binary, light/brightness (0 = Off), light/color, light/
  temperature in kelvin (range of the product, 2700-6500 K by default); no unit
  (none listed by the core for the light category).
- Manifest: `transports` local + cloud, `network_discovery` udp-active-broadcast
  6666, `gladys_version` >=5.1.0, category `lighting`. No `keywords` /
  `countries` yet (they need Gladys 5.3).
- Country select: the 130 countries of python-aidot, English names as the cloud
  expects them, French names from Intl; France by default.

## Next

- [ ] A tester with real lights: the answers of a light (same `seq`? attributes
      in the answer?), the `clientId` prefix, the discovery through the core.
- [ ] Effects (cloud `diffCommand` in python-aidot): left out of 0.1.
- [ ] `keywords` / `countries` once `gladys_version` >= 5.3.0.
