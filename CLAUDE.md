# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors. Read **[TODO.md](./TODO.md) first**: status, decisions already
taken and the next milestones.

## What this is

A Gladys Assistant **external integration** for the AiDot Wi-Fi lights
(Linkind, OREiN…): a Node.js service (Node 22+, ESM, no build step) in its own
sandboxed Docker container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. The AiDot cloud gives the list of the lights with
their address and keys; each light is then driven on the local network (TCP
10000, AES). Ported from python-aidot 0.3.59 (MIT, the maker's library, see
`THIRD_PARTY_NOTICES.md`).

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/off.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
node scripts/cover.mjs cover.png          # the store cover (800x534)
memcap node scripts/mutants.mjs           # the guard mutants of test/mutants.mjs, one by one
```

## Architecture

```
index.js              SDK wiring only (src/handlers.js registers the handlers before connect())
src/app.js            the account and the lights: cloud reads, connections, states, commands, Offs held, status
src/cloud.js          the AiDot cloud: sign-in, refresh, houses, devices, products; its errors
src/http.js           the only HTTPS access (bounded)
src/link.js           the TCP connection to one light: login, one request in flight, priorities, cut, heartbeat
src/protocol.js       frames, AES, messages, attributes, discovery (pure)
src/model.js          a device of the cloud -> a light (address, keys, capabilities) (pure)
src/devices.js        a light -> its Gladys device (pure)
src/store.js          /data: salt, terminal id, refusal mark, pause, last cloud read, Offs held
src/config.js         the configuration (credentials, country, interval, language)
src/countries.js      the countries and cloud regions of python-aidot
src/publisher.js      states to Gladys within 300 per minute
src/i18n.js           texts in English and French
test/                 node --test: fake cloud and lights on a virtual clock, a real TCP light on a real clock (x20)
```

## Rules

- **External ids are forever**: `ext:<selector>:light:<cloud device id>`;
  feature keys `power`, `brightness`, `color`, `temperature`.
- **The application id of python-aidot** is used for this integration only
  (Louis, 2026-11-05). Never add another imitation (User-Agent, signature).
- **Secrets**: the password, the tokens, the user id, the keys and passwords of
  the lights never go to a log, the status, an error or `/data`; tokens and keys
  stay in memory. `/data` holds a 6-bit mark of a refused password only.
- **The password is posted only when allowed**: never after a refusal kept for
  the same credentials, but on new credentials saved or the test button.
- **An Off is never held back** (see the header of `src/app.js`): any change on
  its path keeps a test that kills its mutant, listed in `test/mutants.mjs`
  (`node scripts/mutants.mjs` must end with ALL KILLED); no test may hang.
- **Order**: a read that left before a command or a push of the light never
  applies its state after them (`tick` / `mark`).
- **Two clocks**: `monotonic` for every decision, `now` for /data and messages.
- **The container rootfs is read-only**: write only under `/data`.
- **Versions belong to the Release workflow**; `CHANGELOG.md` under
  `## [Unreleased]`; user-facing text in English and French, docs in sync.
