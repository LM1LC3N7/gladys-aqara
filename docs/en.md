# Aqara (Aqara Open API)

Brings the devices of your Aqara account into Gladys: the hubs (M2, M3,
M1S…) and what is paired behind them — temperature, humidity and pressure
sensors, door and window sensors, leak, presence, smoke and CO detectors,
plugs, lights and curtains. Through the official **Aqara Open API** (the
cloud), with a developer project of your own. Unofficial integration, not
affiliated with Aqara. It was never tested with a real device: please report
what works and what does not.

## 1. Create a developer project

1. Sign in on <https://developer.aqara.com/> with an Aqara account (it may be
   the one of your Aqara Home app).
2. Console, **Project Management**, **New project**; wait until it is
   approved.
3. In the details of the project: the **App ID**; in **Key Management**: the
   **Key ID** and the **App Key**.

Copy the three values into the configuration and pick the **server** of your
Aqara account (Europe, United States, China mainland, South Korea, Russia,
Singapore: the one chosen in the Aqara Home app). The App Key is kept by
Gladys in its database, never shown again; it only signs the requests (MD5
signature of the documentation) and never leaves the integration itself.

## 2. Authorize your Aqara account

1. Enter the e-mail address or the phone number of the Aqara account that
   owns the devices, and save.
2. Click **Send the verification code**: Aqara sends a verification code to
   that account (e-mail or SMS), valid 10 minutes. A code is asked only when
   you click, never at start nor by a read, and never twice within a minute.
3. Enter the code in the **Authorize** button and click it. The two tokens
   (access and refresh) are filled in the configuration by the integration.

The access token is asked for 7 days and renewed with the refresh token a
day before it expires (or when Aqara says it expired); the renewed tokens
are saved in the configuration of Gladys. If Aqara refuses the renewal (the
refresh token expired after 30 more days without any read, or was revoked),
the status says "authorize again": nothing is sent with these tokens any
more until you authorize again.

The keys, the tokens, the account and the code are never written in the
logs, the status or `/data`.

## Devices

**Discovery** offers each device that has at least one value below, built
from the "trait" description Aqara gives of its model:

| Aqara trait                                                                        | Gladys                                | Commanded |
| ---------------------------------------------------------------------------------- | ------------------------------------- | --------- |
| OnOff of a light                                                                   | light on/off                          | yes       |
| CurrentLevel of a light (%)                                                        | light brightness 0-100                | yes       |
| OnOff of an outlet or a switch                                                     | switch on/off                         | yes       |
| CurrentPositionPercentage / TargetPositionPercentage                               | curtain position (0 closed, 100 open) | yes       |
| CurrentTemperature (°C), CurrentHumidity (%), CurrentPressure (kPa)                | sensors                               | no        |
| CurrentIlluminance (lux), CO2Density (ppm), PM2.5Density (µg/m³), VOCDensity (ppb) | sensors                               | no        |
| BatPercentRemaining (%)                                                            | battery                               | no        |
| CurrentPower (W), CurrentVoltage (V), CircuitCurrent (A)                           | power, voltage, current               | no        |
| ContactSensorState                                                                 | opening sensor                        | no        |
| LeakState, Occupancy, SmokeDetected, CODetected                                    | leak, presence, smoke, CO             | no        |

A value in another unit than the one listed, out of its range, or a text, is
unknown: it is never published (never as 0). An offline device (Reachable
false) publishes nothing. A measurement is published once per source date,
never when older than 2 hours (a value without a source date is
published while the device is online); on/off, positions and detectors are published
as the current state.

**Read only in this version**: locks, cameras, doorbells, garage doors,
valves, pumps, window openers, heating and air conditioning: a device of one
of these types is never written, even its other values (a lock is never
opened). The energy counter (CumulativeEnergyConsumption), colours and
colour temperature, buttons and cubes (events only) are not handled yet.

Assumption to check on a real device: a contact sensor "true" means open
unless Aqara's description of the model names the values (Open / Close).

## Commands

- **Turning off** (on/off 0, brightness 0) and **closing a curtain**
  (position 0) are sent at once, during a pause asked by Aqara, beyond the
  daily budget, before the device list is read again (right after a restart,
  the device params of Gladys say where to write), and when `/data` cannot be
  read. A read in progress is cut for it. Refusals of a stop: no
  configuration yet (kept 2 minutes, sent once it is read), keys or tokens
  missing, keys or authorization refused by Aqara during this run, a value
  read only, a value not known yet (no read since the start and no device
  params in Gladys). It is confirmed by the reads 5 s and 20 s later; contradicted
  (the old value with no newer source date), it is sent again, twice at most;
  changed after it (a newer source date: the Aqara app, a wall switch, an
  automation), it is not sent again. A send that could not leave (network,
  429, 5xx, device offline) is tried again every 10 s, 6 times in 2 minutes.
- **Turning on, a brightness, a curtain position above 0** are refused
  during a pause, beyond the budget, when the device list is older than 15
  minutes, when the device is offline or the value read only. Sent, they are
  confirmed the same way (reads 5 s and 20 s later). A command queued before
  a turn off of the same endpoint never leaves after it.

Aqara has no "stop" for a curtain in its trait model: only the position is
offered.

## Reads and quota

Every read costs one call per 50 values, plus the device list every 10
minutes and the descriptions of the new models. Default every 120 s (60 s at
least). The **daily budget** (3000 calls by default, UTC day) is counted
before each call and kept across restarts: once spent, reads stop until the
next day; turning off and closing still go. Set it below the quota of your
project. A 429, or a busy server during a read (codes 100, 104, 5xx), pauses
everything but the stops (a 5xx answering one command pauses nothing), 1 minute doubled up to 6 hours (or the Retry-After when
longer), kept across restarts. One read request at a time.

Refusals: the keys refused (codes 106, 107, 2002…) stop everything until
you change them or click **Test the connection** (which always tries); a
permission refused on one route (2008, 403…) is never taken for a refusal of
the keys.

## Troubleshooting

- "refused the keys of the project": check App ID, Key ID, App Key and the
  server; a project not approved yet is refused too.
- "Aqara refused the date of the request": the clock of the Gladys host is
  wrong.
- "a permission refused (an IP restriction of the project?)": the IP
  settings of the project only allow other addresses.
