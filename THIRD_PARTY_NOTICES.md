# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, published by the maker of the
lights. The ported parts were rewritten in JavaScript; they are changed from the
original (another language, another structure, only what this integration
needs). None of the original code is copied as is, but the constants listed
below.

## python-aidot

- Project: [Aidot-Development-Team/python-aidot](https://github.com/Aidot-Development-Team/python-aidot)
  version 0.3.59 (commit 0df6e4d, 2026-09-30), "Can control the WiFi lights of
  AIDOT in the local area network", by the Aidot Development Team, MIT
  licence; the library of the Home Assistant AiDot integration.
- What is ported:
  - the cloud (`aidot/client.py`, in `src/cloud.js`): the hosts
    `prod-<region>-api.arnoo.com/v35`, the routes
    `/users/loginWithFreeVerification`, `/users/refreshToken`, `/houses`,
    `/devices?houseId=`, `/products/<ids>`, the headers `Appid`, `Terminal`,
    `Token`, the body of the sign-in (`countryKey`, `username`, the password
    under RSA PKCS#1 v1.5, `terminalId`, `webVersion`, `area`, `UTC`) and the
    error codes 560080, 21026, 21025, 21027, 21041;
  - the constants of `aidot/login_const.py`, used as they are: the public key
    of the sign-in and **the application id `1383974540041977857`** of the
    library. That id identifies the maker's own library to its cloud; Louis
    accepted its use for this integration only (2026-11-05, see `TODO.md`);
  - the countries and their region (`aidot/const.py`, in `src/countries.js`);
  - the local protocol (`aidot/device_client.py`, `aidot/aes_utils.py`,
    `aidot/models/*`, in `src/protocol.js` and `src/link.js`): the frames
    (magic `0x1EED`, type, length), AES-ECB / PKCS#7 with the key of the light
    zero-padded to 16 bytes, `loginReq` and its `ascNumber`, `getDevAttrReq`,
    `setDevAttrReq` (long form with `simpleVersion`, short form without), the
    attributes `OnOff`, `Dimming`, `RGBW` (packed r<<24|g<<16|b<<8|w),
    `CCT`, the heartbeat `pingreq` (frame type 2), the first generation of
    lights read instead of pinged, the capabilities `control.light.rgbw` and
    `control.light.cct` of a product;
  - the discovery (`aidot/discover.py`, in `src/protocol.js`): the
    `devDiscoveryReq` on UDP port 6666 with the fixed key `T54uednca587` of the
    protocol (AES-256-ECB), its `devId` answers.
- Changes: rewritten in JavaScript for a Gladys external integration; our own
  prefixes in `seq` (`gl01`) and `clientId` (`gl-`) instead of the "ha"
  ones of the library; one request in flight per light with priorities, answers
  matched by their `seq` and read as untrusted data (bounded frames, strict
  values, a light that does not open with its key refused); the discovery sent
  through the Gladys core (`scanNetwork`), the addresses limited to the local
  network; the effects (cloud commands) left out.

```
MIT License

Copyright (c) 2024 Aidot Development Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
