# TODO — Aqara v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-11-15): signed requests of the Aqara Open
      API (regional servers), authorization by verification code (on a
      click only) and token renewal saved in Gladys; device list, trait
      descriptions (qlink models and Matter devices), values; sensors,
      detectors, plugs, lights, curtain positions; stops (turn off, close)
      confirmed by follow-up reads, kept in `/data`; daily call budget,
      pauses, refusals; docs en/fr; tests on a fake Aqara HTTP server
      (virtual and real clock), mutants.
- [ ] **Milestone 2 — real account**: a developer project and a hub M2/M3:
      check the field names of the trait answers (`parameter` or
      `attribute`, `deviceType` or `endpointTypes`), the value types (bool
      or "0"/"1"), the trait code of the temperature (`CurrentTemperature`
      is not in the published list), the units declared, the meaning of
      `ContactSensorState`, curtain 0 = closed, the HTTP status of the error
      answers, the quota of a free project, whether `config.auth.getAuthCode`
      returns the code in its answer (never read nor logged here).
- [ ] **Milestone 3 — more devices**: energy counter
      (CumulativeEnergyConsumption, with the p1-monitor guard), colour and
      colour temperature, buttons and cubes (push through Gladys Plus
      webhooks: Aqara message push), dynamic endpoints (FP2, M3), thermostats
      (bounded set points, option), lock state read only.
- [ ] **Milestone 4 — first release**: Docker image, store validator,
      Release workflow, topic.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- Manifest: categories `protocols`, `lighting`, `environment`; no
  `keywords`; no `countries` (Aqara serves the world through six servers).
- Reference: the official documentation only (opendoc.aqara.com, GitBook
  pages, file date 2026-08-26); no code read or ported. The signature
  example of the page hashes the Key ID without its "k." prefix (the Java
  demo): the unit test uses that one.
- Trait model (`spec.query.*`) rather than the older resource ids
  (`4.1.85`...): standard trait codes, units and ranges given by the API.
- External ids `ext:aqara:device:<prefix>-<rest>` (first dot of the did as a
  dash, the prefix has no dash: reversible), features `e<endpoint>-<key>`.
- Where each commanded value is written is in the device params
  (`aqara_write_<key>`): a stop right after a restart needs no read.
- Stops: turn off (OnOff false, brightness 0) and close (position 0).
  Independent of pauses, budget, device list, `/data`; they cut a read in
  flight. Confirmed by reads at 5 s and 20 s; contradicted with no newer
  source date: sent again (2 at most); changed after (newer source date):
  never fought. Not sent: retried every 10 s, 6 tries, 2 minutes.
- Curtain: no stop trait in the trait model, so no `curtain/state`.
- Tokens: in the Gladys configuration only (`setConfig`); `/data` keeps the
  expiry and a 6-bit salted mark of the refresh token. Renewed a day before
  expiry or on code 108/2005, once per request; a refused renewal (2006,
  2007, or a token refused just after a renewal) ends the authorization,
  kept as a 6-bit mark; lifted by new tokens (Authorize) or new keys.
- Keys refused (106, 107, 2002, 2012, 2013, 2022): kept as a mark; lifted by
  new keys, a new authorization or a success of the test button. Permission
  codes (403, 2008, 2014...) are never a refusal of the keys.
- Daily budget of calls (default 3000, UTC day) counted before each call,
  in `/data` every 20 calls and with each save; stops are never refused by it.
- Verification code: one request per click, never two within 60 s (wall date
  in `/data` too); the answer is never read nor logged.
