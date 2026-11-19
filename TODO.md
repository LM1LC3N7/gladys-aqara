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
      `ContactSensorState`, the HTTP status of the error
      answers, the quota of a free project, whether `config.auth.getAuthCode`
      returns the code in its answer (never read nor logged here).
      **Curtains: a tester must confirm the direction of the positions
      (0 = closed? the documentation gives none, HomeKit and Matter are
      opposite) before any position is written**; then writing comes back
      with a close as a turn-off-like stop never replayed after a restart
      (review r1, I5).
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
- Positions read only in v1, for every device type (coordinator, review r1):
  the documentation gives no direction; no position is ever written, no
  write param is published for it, no close is kept in `/data`.
- Stops: turn off only (OnOff false, brightness 0). Independent of pauses,
  budget, a due renewal (sent with the current token; a renewal only when
  Aqara says the token expired), device list, `/data`; they cut a read in
  flight. Confirmed by reads at 5 s and 20 s; contradicted with an older
  source date: sent again (2 at most); a newer source date: never fought;
  no source date or no read: not sent again, "Not confirmed" in the status.
  Not sent: retried every 10 s, 6 tries, 2 minutes.
- Starts: checked again right before their bytes (stop since the click,
  3 s deadline), also after a renewal; cut by an AbortSignal at the deadline
  when not gone ("nothing sent" never leaves later). Device list age limit:
  max(15 min, 2 read intervals).
- Nothing leaves after `stop()` (checked before every request, and again
  at the connection, before the first byte: `beforeSend` of src/http.js).
- A turn off cuts the starts of its endpoint not gone yet (AbortSignal); a
  start already gone at the click marks the stop `raced`: its newer source
  date never ends the stop (review r2, N1).
- During the spacing after a fresh token refused, no renewal at all; a stop
  is sent with the current token (review r2, M9).
- Curtain: no stop trait in the trait model, so no `curtain/state`.
- Tokens: in the Gladys configuration only (`setConfig`); `/data` keeps the
  expiry and a 6-bit salted mark of the refresh token. Renewed a day before
  expiry or on code 108/2005, once per request; a refused renewal (2006, 2007) ends the authorization,
  kept as a 6-bit mark; lifted by new tokens (Authorize) or new keys.
- Keys refused only on 106 (invalid sign), 107 (illegal appKey), 2002 (Appid
  or Appkey illegal): kept as a mark; lifted by new keys, a new authorization
  or a success of the test button. 2012, 2013, 2022 and the other permission
  codes (403, 2008, 2014...) are never a refusal of the keys (review r1, I3).
- An access token refused right after an accepted renewal: "not read",
  spaced (doubled up to an hour), never the end of the authorization; stops
  retry it (review r1, I4). A refused refresh token is never sent again, not
  by the test button (which only tries the keys) nor by a stop (review r1, M2).
- Read only also: Hearth, Oven, Cooktop, CookSurface, ElectricCooker,
  MicrowaveOven (review r1, M5).
- Daily budget of calls (default 3000, UTC day) counted before each call,
  in `/data` every 20 calls and with each save; stops are never refused by it.
- Verification code: one request per click, never two within 60 s (wall date
  in `/data` too); the answer is never read nor logged.
