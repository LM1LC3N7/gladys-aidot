# gladys-aidot

[Gladys Assistant](https://gladysassistant.com) external integration for the
**AiDot Wi-Fi lights** (Linkind, OREiN and the other brands of the AiDot app):
power, brightness, colour and colour temperature, the changes pushed by the
lights shown at once.

- **The AiDot cloud for the list only**: sign-in with the e-mail and password
  of the account, then the houses, devices and products, which give the
  address and the local keys of each light. It signs in with the **application
  id of python-aidot**, the maker's own library (MIT, Aidot Development Team,
  used by Home Assistant): accepted by Louis for this integration only
  (2026-11-05). No other imitation (no User-Agent of the app).
- **The lights on the local network**: TCP port 10000, frames `1EED` with the
  JSON in AES-ECB under the key of each light, `loginReq`, `getDevAttrReq`,
  `setDevAttrReq`; the addresses from the cloud or from a discovery broadcast
  by the Gladys core (`network_discovery` `udp-active-broadcast` port 6666).
- **Offs first**, kept in `/data` and sent again until the light shows them off
  (4 answered tries at most). After a restart the keys come from the cloud
  first: nothing, an Off included, can be driven before that read (never while
  the credentials are refused or the cloud does not answer).
- **The password is never sent again by itself after a refusal**; 429 / 5xx
  pause the cloud; nothing secret in a log, the status or `/data`.

Never tested with a real device: tested against a fake cloud and fake lights
built from python-aidot. Not affiliated with AiDot.

User documentation: [English](docs/en.md), [français](docs/fr.md). Contributor
rules: [CLAUDE.md](CLAUDE.md), status and decisions: [TODO.md](TODO.md).

## Development

```bash
npm install
npm test                       # node --test --test-timeout=60000
npm run lint && npm run format:check
node scripts/mutants.mjs       # the guard mutants of test/mutants.mjs, one by one
node scripts/cover.mjs cover.png
```

Licence: Apache-2.0 (see `LICENSE`); third-party notices in
`THIRD_PARTY_NOTICES.md`.
