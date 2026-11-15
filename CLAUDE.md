# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16). It
reads and drives the devices of an Aqara account through the official Aqara
Open API (opendoc.aqara.com), with the user's developer project (App ID, Key
ID, App Key) and an authorization by verification code. Not affiliated with
Aqara.

## Commands

```bash
npm install
npm test                 # node --test --test-timeout=60000
npm run lint
npm run format:check
npm run audit
npm run mutants          # under memcap on a dev VM
```

## Architecture

```
index.js           SDK bootstrap only
src/handlers.js    every SDK handler -> the app (shared with the tests)
src/app.js         AqaraApp: config, tokens, reads, Discovery, commands, stops, buttons
src/api.js         the signed requests, answer classification by return code
src/http.js        the only network access: one bounded, abortable request
src/model.js       device list, trait descriptions -> devices, values, commands (pure)
src/store.js       /data (no secret)
src/publisher.js   states within the Gladys rate limit
src/config.js      config_schema normalized
src/i18n.js        runtime texts (en/fr)
test/helpers/      fake Aqara HTTP server, virtual and real clocks
scripts/           cover.png, mutants
```

## Rules

- External ids are forever (`ext:<selector>:device:<prefix>-<rest>` from the
  did, feature keys `e<endpoint>-<key>`). Manifest keys are frozen.
- A verification code is asked on a click of "Send the verification code"
  only: never at start, by a read, a retry or a restart.
- Turning off is never held by a pause, the daily budget, a token renewal,
  the device list or `/data`. Positions are never written (v1, direction
  unconfirmed). Devices of the types of `NEVER_COMMANDED` (locks, cameras,
  valves, garage doors, heating, cooking...) are never written.
- No key, token, account or code in logs, status, errors or `/data`; the
  forbidden words of test/encoding.test.js stay out of every text.
- `monotonic` for every decision, `now` only for `/data`, the Time header,
  token expiry, the budget day and source dates.
- A guard whose mutant survives gets a test, never removed.
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` in sync.
