// -----------------------------------------------------------------------------
// The points of review r1 (I2-I6, M1-M6) and the guards whose mutants
// survived it: each test names what it defends.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  F,
  answer,
  command,
  createdDevices,
  flush,
  setup,
  status,
  statesOf,
  until,
} from './helpers/app.js';
import { CODE, aqara, fakeAqara, reply } from './helpers/fakeAqara.js';
import { testClock } from './helpers/clock.js';
import { grantText, normalizeConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { featuresOf, parseDescription } from '../src/model.js';
import { StatePublisher } from '../src/publisher.js';
import { fileStore, mark, memoryStore } from '../src/store.js';

const PLUG = F('lumi.plug0001', 'e1-onoff');
const LIGHT = F('lumi.light0001', 'e1-onoff');
const TEMP = F('lumi.weat0001', 'e1-temperature');

const writes = (srv) => srv.of('spec.write.trait').map((r) => r.data.traits[0]);

/** A route answered when the test says so (`release(answer)`); the virtual clock moves meanwhile. */
function deferred() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

/** The access token known to expire within the hour (a renewal is due). */
function expiresSoon(app, clock) {
  app.memory.token = {
    mark: mark(app.memory.salt, app.tokens().refresh),
    expires: clock.now() + 3_600_000,
  };
}

// --- I2: a renewal never holds a stop; a start answered "nothing sent" never leaves ---------

test('I2a: a turn off never waits for a due renewal: sent at once with the current token', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  expiresSoon(app, clock);
  const slow = deferred();
  srv.routes['config.auth.refreshToken'] = () => slow.promise;
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /^Sent/);
  assert.equal(writes(srv).length, 1);
  assert.equal(srv.count('config.auth.refreshToken'), 0);
  slow.release(aqara(500));
});

test('I2b: a turn on answered "nothing sent" while a renewal is slow never leaves afterwards', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  expiresSoon(app, clock);
  const slow = deferred();
  srv.routes['config.auth.refreshToken'] = (r, s) =>
    slow.promise.then(() => s.defaults['config.auth.refreshToken'](r, s));
  await assert.rejects(answer(ctx, command(ctx, LIGHT, 1)), /Nothing sent/);
  slow.release();
  await until(
    clock,
    () => srv.count('config.auth.refreshToken') === 1 && !app.refreshing,
    'renewal',
  );
  await clock.advance(10_000);
  assert.equal(writes(srv).filter((w) => w.value === true).length, 0);
});

test('I2c: a turn on waiting for a renewal never leaves after a newer turn off', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  expiresSoon(app, clock);
  const slow = deferred();
  srv.routes['config.auth.refreshToken'] = (r, s) =>
    slow.promise.then(() => s.defaults['config.auth.refreshToken'](r, s));
  const on = command(ctx, LIGHT, 1);
  on.catch(() => {});
  await clock.advance(300);
  assert.match(await answer(ctx, command(ctx, LIGHT, 0)), /^Sent/);
  slow.release();
  const result = await Promise.allSettled([answer(ctx, on)]);
  assert.match(String(result[0].reason?.message), /turn off came after it|Nothing sent/);
  await clock.advance(5_000);
  assert.deepEqual(
    writes(srv).map((w) => w.value),
    [false],
  );
});

// --- I3: 2012 / 2013 are permissions, never a refusal of the keys ------------------------------

test('I3a: code 2013 on the descriptions is no refusal of the keys; a stop still leaves', async (t) => {
  const ctx = await setup(t, { connect: false, firstRead: false });
  const { app, srv, gladys, clock } = ctx;
  srv.routes['spec.query.qlinkmodel.config'] = () => aqara(2013, 'Developer Permission denied');
  await gladys.connect();
  await until(clock, () => app.lastResult !== undefined, 'read');
  assert.equal(app.keysRefused(), false);
  assert.doesNotMatch(status(gladys), /refused the keys/);
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /^Sent/);
});

test('I3b: code 2012 or 2013 on a write refuses that write only; another stop still leaves', async (t) => {
  const ctx = await setup(t);
  const { app, srv } = ctx;
  srv.routes['spec.write.trait'] = (r, s) =>
    r.data.traits[0].deviceId === 'lumi.plug0001'
      ? aqara(2013)
      : s.defaults['spec.write.trait'](r, s);
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /refused it \(code 2013\)/);
  assert.equal(app.keysRefused(), false);
  assert.match(await answer(ctx, command(ctx, LIGHT, 0)), /^Sent/);
  srv.routes['spec.write.trait'] = () => aqara(2012);
  await answer(ctx, command(ctx, LIGHT, 0));
  assert.equal(app.keysRefused(), false);
});

// --- I4: a token refused right after its renewal ---------------------------------------------

test('I4: a fresh token refused is "not read, spaced", never the end of the authorization; stops still leave', async (t) => {
  const ctx = await setup(t, { connect: false, firstRead: false });
  const { app, srv, gladys, clock } = ctx;
  srv.tokens = { access: 'ACCESS-other-0009', refresh: srv.tokens.refresh };
  srv.routes['query.device.info'] = () => aqara(2004, 'AccessToken incorrect');
  await gladys.connect();
  await until(clock, () => app.lastResult !== undefined, 'read');
  assert.equal(srv.count('config.auth.refreshToken'), 1);
  assert.equal(app.lastResult.kind, 'fresh-token');
  assert.equal(app.grantRefused(), false);
  assert.equal(app.grantRefusedProven(), false);
  assert.match(status(gladys), /refused an access token it had just renewed/);
  assert.ok(app.tokenWait.until - app.monotonic() > app.config.pollMs);
  // Spaced: no read at the plain interval.
  const n = srv.count('query.device.info');
  await clock.advance(app.config.pollMs + 100);
  assert.equal(srv.count('query.device.info'), n);
  // Whatever plans a read (a configuration saved, a reconnection): the spacing holds.
  app.schedulePoll(0);
  await clock.advance(100);
  assert.equal(srv.count('query.device.info'), n);
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /^Sent/);
});

// --- M1: nothing after stop() --------------------------------------------------------------

test('M1a: a follow-up read queued behind a slow read never leaves after stop()', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  srv.routes['spec.query.trait'] = () => 'hang';
  await clock.advance(120_100);
  await until(clock, () => srv.hanging === 1, 'slow read', { step: 1 });
  srv.routes['spec.write.trait'] = (r, s) => s.defaults['spec.write.trait'](r, s);
  await answer(ctx, command(ctx, LIGHT, 1));
  await clock.advance(5_100);
  await app.stop();
  const n = srv.requests.length;
  delete srv.routes['spec.query.trait'];
  srv.release();
  await clock.advance(60_000);
  assert.equal(srv.requests.length, n);
});

test('M1b: a start waiting for a stop in flight never leaves after stop(); nor a stop resend', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  const slow = deferred();
  srv.routes['spec.write.trait'] = (r, s) =>
    r.data.traits[0].value === false
      ? slow.promise.then(() => s.defaults['spec.write.trait'](r, s))
      : s.defaults['spec.write.trait'](r, s);
  const off = command(ctx, LIGHT, 0);
  off.catch(() => {});
  await clock.advance(10);
  const on = command(ctx, LIGHT, 1);
  on.catch(() => {});
  await clock.advance(10);
  await app.stop();
  slow.release();
  await clock.advance(30_000);
  assert.deepEqual(
    writes(srv).map((w) => w.value),
    [false],
  );
  const stop = [...app.stops.values()][0];
  if (stop) {
    const attempts = stop.attempts;
    assert.equal(await app.sendStop(stop), 'not-sent');
    assert.equal(stop.attempts, attempts);
  }
});

test('sendStop after stop(): nothing counted, nothing sent', async (t) => {
  const ctx = await setup(t);
  const { app, srv } = ctx;
  const stop = {
    did: 'lumi.plug0001',
    key: 'e1-onoff',
    attempts: 0,
    sent: 0,
    resends: 0,
    atMono: app.monotonic(),
    at: app.now(),
  };
  stop.feature = app.featuresOfDevice(app.devices.get('lumi.plug0001'))[0];
  app.stops.set('lumi.plug0001|e1-onoff', stop);
  await app.stop();
  assert.equal(await app.sendStop(stop), 'not-sent');
  assert.equal(stop.attempts, 0);
  assert.equal(writes(srv).length, 0);
});

// --- M2: a refused refresh token is never sent again ------------------------------------------

test('M2a: after a refused renewal, the test button says authorize again and sends nothing', async (t) => {
  const ctx = await setup(t, { connect: false, firstRead: false });
  const { app, srv, gladys, clock } = ctx;
  srv.tokens = { access: 'ACCESS-other-0009', refresh: 'REFRESH-other-0009' };
  await gladys.connect();
  await until(clock, () => app.grantRefused(), 'refusal');
  // Right after the read: the answer is "authorize again", nothing else.
  assert.match((await answer(ctx, app.testConnection())).en, /^Aqara refused the renewal/);
  assert.doesNotMatch((await answer(ctx, app.testConnection())).en, /Next read possible/);
  await clock.advance(61_000);
  const n = srv.requests.length;
  assert.match((await answer(ctx, app.testConnection())).en, /authorize again/);
  assert.equal(srv.requests.length, n);
});

test('M2b: a refusal mark kept in /data: a stop answered 108 never sends the refused refresh token', async (t) => {
  const config = normalizeConfig({
    region: 'ger',
    app_id: 'appid0123456789abcdef',
    key_id: 'K.0123456789',
    app_key: 'APPKEY-secret-0001',
    access_token: 'ACCESS-token-0001',
    refresh_token: 'REFRESH-token-0001',
  });
  const salt = '1'.repeat(32);
  const data = { salt, grantRefused: { mark: mark(salt, grantText(config)) } };
  const ctx = await setup(t, { data, firstRead: false });
  const { srv } = ctx;
  srv.routes['spec.write.trait'] = () => aqara(108, 'Token has expired');
  await answer(ctx, command(ctx, PLUG, 0));
  assert.equal(srv.count('spec.write.trait'), 1, 'the stop is tried (a mark is a hint)');
  assert.equal(srv.count('config.auth.refreshToken'), 0);
});

// --- M3: hourly reads do not refuse starts for 45 minutes --------------------------------------

test('M3: with one read an hour, a start 16 minutes after the read is accepted', async (t) => {
  const ctx = await setup(t, { config: { poll_seconds: 3600 } });
  const { app } = ctx;
  app.listAt = app.monotonic() - 16 * 60_000;
  assert.match(await answer(ctx, command(ctx, LIGHT, 1)), /^Sent/);
  app.listAt = app.monotonic() - 121 * 60_000;
  await assert.rejects(answer(ctx, command(ctx, LIGHT, 1)), /too old/);
});

// --- M4 / M6: stops without proof are said, never fought nor silently dropped ----------------

test('M4: a contradicted stop without a source date is not sent again; said as not confirmed', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock, gladys } = ctx;
  srv.applyWrites = false;
  srv.data.values['lumi.plug0001|1|OnOff'] = { value: true, time: null };
  await answer(ctx, command(ctx, PLUG, 0));
  await until(clock, () => app.stops.size === 0, 'stop ended', { step: 100, max: 60_000 });
  assert.equal(srv.count('spec.write.trait'), 1);
  assert.match(status(gladys), /Not confirmed by Aqara: turning off Kettle plug/);
});

test('M6: a stop whose follow-up reads all fail ends as not confirmed', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock, gladys } = ctx;
  srv.routes['spec.query.trait'] = () => reply(500, 'down');
  await answer(ctx, command(ctx, PLUG, 0));
  await until(clock, () => app.stops.size === 0, 'stop ended', { step: 100, max: 60_000 });
  assert.match(status(gladys), /Not confirmed by Aqara/);
});

// --- M5: heating and cooking types read only ----------------------------------------------------

test('M5: a hearth, an oven or a cooktop with a switch endpoint stays read only', () => {
  for (const type of [
    'Hearth',
    'Oven',
    'Cooktop',
    'CookSurface',
    'ElectricCooker',
    'MicrowaveOven',
  ]) {
    const d = parseDescription({
      deviceTypesList: [type],
      endpoints: [
        {
          endpointId: 1,
          deviceType: 'Switch',
          functions: [
            {
              functionCode: 'Output',
              traits: [{ traitCode: 'OnOff', parameter: { readable: true, writable: true } }],
            },
          ],
        },
      ],
    });
    assert.deepEqual(
      featuresOf(d).map((f) => f.writable),
      [false],
      type,
    );
  }
});

// --- I6: the guards of the surviving mutants -----------------------------------------------

test('OnOff only on a light, outlet or switch endpoint; brightness only up to 100', () => {
  const d = parseDescription({
    endpoints: [
      {
        endpointId: 1,
        deviceType: 'Fan',
        functions: [
          {
            functionCode: 'Output',
            traits: [{ traitCode: 'OnOff', parameter: { readable: true, writable: true } }],
          },
        ],
      },
      {
        endpointId: 2,
        functions: [
          {
            functionCode: 'Output',
            traits: [{ traitCode: 'OnOff', parameter: { readable: true, writable: true } }],
          },
        ],
      },
      {
        endpointId: 3,
        deviceType: 'Light',
        functions: [
          {
            functionCode: 'Output',
            traits: [{ traitCode: 'OnOff', parameter: { readable: true, writable: true } }],
          },
          {
            functionCode: 'Level',
            traits: [
              {
                traitCode: 'CurrentLevel',
                parameter: { readable: true, writable: true, max: 254 },
              },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    featuresOf(d).map((f) => f.key),
    ['e3-onoff'],
  );
});

test('a write refused per trait (code in the answer) is a refusal, for a start and for a stop; 602 is tried again', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  let code = 1007;
  srv.routes['spec.write.trait'] = (r) => ({ data: r.data.traits.map((x) => ({ ...x, code })) });
  await assert.rejects(answer(ctx, command(ctx, LIGHT, 1)), /refused the command \(code 1007\)/);
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /refused it \(code 1007\)/);
  assert.equal(app.stops.size, 0);
  code = 602;
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /Nothing sent yet/);
  const n = srv.count('spec.write.trait');
  await clock.advance(10_100);
  assert.ok(srv.count('spec.write.trait') > n, 'tried again');
});

test('a renewal answered after a new authorization never replaces it', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  expiresSoon(app, clock);
  const slow = deferred();
  srv.routes['config.auth.refreshToken'] = () => slow.promise;
  await clock.advance(120_100); // a read starts, its renewal hangs
  await until(clock, () => srv.count('config.auth.refreshToken') === 1, 'renewal');
  // Within the 10 s of the renewal request: its answer still counts.
  await answer(ctx, app.sendCode());
  await answer(ctx, app.authorize({ code: CODE }));
  const authorized = app.tokens().refresh;
  slow.release({
    expiresIn: '604800',
    accessToken: 'ACCESS-late-0001',
    refreshToken: 'REFRESH-late-0001',
  });
  await until(clock, () => !app.refreshing, 'renewal answered');
  assert.equal(app.tokens().refresh, authorized);
});

test('a start not gone at its 3 s answer is cut (a slow connection), never sent later', async (t) => {
  const clock = testClock({ start: Date.UTC(2026, 10, 15, 10) });
  const { request: httpRequest, HttpError: E } = await import('../src/http.js');
  // The write requests wait 4 s before they can leave (a connection that takes long).
  const slowConnect = (url, opts) =>
    opts.body?.includes('spec.write.trait')
      ? new Promise((resolve, reject) => {
          const go = () => {
            if (opts.signal?.aborted) reject(new E('aborted', false));
            else httpRequest(url, opts).then(resolve, reject);
          };
          clock.timers.setTimeout(go, 4_000);
        })
      : httpRequest(url, opts);
  const ctx = await setup(t, { clock, app: { request: slowConnect } });
  const { srv } = ctx;
  await assert.rejects(answer(ctx, command(ctx, LIGHT, 1)), /Nothing sent/);
  await clock.advance(10_000);
  assert.equal(srv.count('spec.write.trait'), 0);
});

test('a start never leaves while a stop of the same endpoint is in flight', async (t) => {
  const ctx = await setup(t);
  const { srv, clock } = ctx;
  srv.routes['spec.write.trait'] = (r) =>
    r.data.traits[0].value === false
      ? 'hang'
      : { data: r.data.traits.map((x) => ({ ...x, code: 0 })) };
  const off = command(ctx, LIGHT, 0);
  off.catch(() => {});
  await clock.advance(10);
  await assert.rejects(answer(ctx, command(ctx, LIGHT, 1)), /Nothing sent/);
  assert.deepEqual(
    writes(srv).map((w) => w.value),
    [false],
  );
  srv.release();
});

test('a stop retry waits for a start in flight, and the accepted start ends it', async (t) => {
  let down = true;
  const ctx = await setup(t, {
    inject: (url, opts) =>
      down && opts.body.includes('"value":false')
        ? new HttpError('network', false, 'ECONNREFUSED')
        : undefined,
  });
  const { srv, clock } = ctx;
  assert.match(await answer(ctx, command(ctx, LIGHT, 0)), /Nothing sent yet/);
  down = false;
  const slow = deferred();
  srv.routes['spec.write.trait'] = (r, s) =>
    r.data.traits[0].value === true
      ? slow.promise.then(() => s.defaults['spec.write.trait'](r, s))
      : s.defaults['spec.write.trait'](r, s);
  await clock.advance(5_000);
  const on = command(ctx, LIGHT, 1);
  on.catch(() => {});
  await clock.advance(6_000); // the stop retry is due meanwhile
  slow.release();
  await clock.advance(20_000);
  assert.deepEqual(
    writes(srv).map((w) => w.value),
    [true],
  );
});

test('a stop clicked before the configuration is read is sent once it is', async (t) => {
  const ctx = await setup(t, { connect: false, firstRead: false });
  const { gladys, srv, clock } = ctx;
  let calls = 0;
  const real = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (calls === 2) throw new Error('host API down');
    return real();
  };
  await gladys.connect();
  assert.match(
    await ctx.app.setValue({}, { external_id: PLUG }, 0),
    /Waiting for the configuration/,
  );
  await until(clock, () => srv.count('spec.write.trait') === 1, 'stop sent', {
    step: 100,
    max: 10_000,
  });
});

test('a restart never reads sooner than the interval after the last attempt (kept in /data, written before the read)', async (t) => {
  const clock = testClock({ start: Date.UTC(2026, 10, 15, 10) });
  const srv = await fakeAqara({ now: clock.now });
  srv.routes['query.device.info'] = () => 'hang';
  const store = memoryStore();
  const ctx = await setup(t, { clock, srv, store, firstRead: false });
  await until(clock, () => srv.hanging === 1, 'read in flight', { step: 1 });
  assert.ok(store.data.lastAttempt > 0, 'written before the read');
  await ctx.app.stop();
  srv.release();
  const ctx2 = await setup(t, { clock, store, firstRead: false });
  await clock.advance(60_000);
  assert.equal(ctx2.srv.count('query.device.info'), 0);
  await until(clock, () => ctx2.srv.count('query.device.info') === 1, 'read at the interval', {
    step: 500,
    max: 70_000,
  });
});

test('the code: written in /data before it is asked, never beyond the budget, spaced on the monotonic clock too', async (t) => {
  const wallOffset = { ms: 0 };
  const ctx = await setup(t, { authorized: false, wallOffset });
  const { app, srv, store } = ctx;
  app.memory.budget = { day: app.today(), calls: app.config.dailyCalls };
  assert.match((await answer(ctx, app.sendCode())).en, /daily budget/);
  assert.equal(srv.count('config.auth.getAuthCode'), 0);
  app.memory.budget.calls = 0;
  srv.routes['config.auth.getAuthCode'] = () => 'hang';
  const first = app.sendCode();
  await until(ctx.clock, () => srv.hanging === 1, 'code asked', { step: 1 });
  assert.ok(store.data.codeAt > 0);
  srv.release();
  await answer(ctx, first);
  delete srv.routes['config.auth.getAuthCode'];
  wallOffset.ms = 120_000; // the wall clock jumps
  assert.match((await answer(ctx, app.sendCode())).en, /less than a minute/);
  assert.equal(srv.count('config.auth.getAuthCode'), 1);
});

test('the test button never reads sooner than a minute after the last read', async (t) => {
  const ctx = await setup(t);
  const n = ctx.srv.requests.length;
  assert.match((await answer(ctx, ctx.app.testConnection())).en, /Next read possible/);
  assert.equal(ctx.srv.requests.length, n);
});

test('the renewal is counted in the daily budget', async (t) => {
  const ctx = await setup(t, { firstRead: false, connect: false });
  const { srv, gladys, app, clock } = ctx;
  srv.expiredToken = srv.tokens.access;
  srv.tokens = { access: 'ACCESS-other-0009', refresh: srv.tokens.refresh };
  await gladys.connect();
  await until(clock, () => app.lastResult?.ok, 'read');
  assert.equal(app.memory.budget.calls, srv.requests.length);
});

test('a follow-up read of a stop during a pause never carries the values of a start', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  const light = app.featuresOfDevice(app.devices.get('lumi.light0001'))[0];
  const plug = app.featuresOfDevice(app.devices.get('lumi.plug0001'))[0];
  app.pauseUntil = app.monotonic() + 3_600_000;
  const due = app.monotonic() + 1_000;
  app.follow.set(LIGHT, { did: 'lumi.light0001', feature: light, protective: false, due: [due] });
  app.follow.set(PLUG, { did: 'lumi.plug0001', feature: plug, protective: true, due: [due] });
  app.planFollow();
  const n = srv.count('spec.query.trait');
  await clock.advance(2_000);
  const reads = srv.of('spec.query.trait').slice(n);
  assert.equal(reads.length, 1);
  assert.deepEqual(
    reads[0].data.traits.map((x) => x.deviceId),
    ['lumi.plug0001'],
  );
});

test('follow-up reads of a start wait out a pause', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  await answer(ctx, command(ctx, LIGHT, 1));
  app.pauseUntil = app.monotonic() + 3_600_000;
  const n = srv.count('spec.query.trait');
  await clock.advance(25_000);
  assert.equal(srv.count('spec.query.trait'), n);
});

test('a measurement of a device not created yet is published once it is; a future date never', async (t) => {
  const devices = createdDevices().filter((d) => d.external_id !== F('lumi.weat0001'));
  const ctx = await setup(t, { devices, connect: false, firstRead: false });
  const { app, srv, gladys, clock } = ctx;
  srv.data.values['lumi.weat0001|1|CurrentHumidity'] = { value: 50, time: clock.now() + 3_600_000 };
  await gladys.connect();
  await until(clock, () => app.lastResult?.ok, 'read');
  gladys.fake.devices.push(createdDevices().find((d) => d.external_id === F('lumi.weat0001')));
  await gladys.getDevices();
  await clock.advance(120_100);
  await until(clock, () => srv.count('spec.query.trait') >= 2, 'second read');
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, TEMP), [21.37]);
  assert.deepEqual(statesOf(gladys, F('lumi.weat0001', 'e1-humidity')), []);
});

test('a state that waited longer than its freshness is never published late', async () => {
  let t = 0;
  const sent = [];
  const gladys = {
    publishChangedStates: async (states) => {
      sent.push(...states);
      return { count: states.length };
    },
  };
  const p = new StatePublisher({
    gladys,
    logger: console,
    monotonic: () => t,
    timers: { setInterval() {}, clearInterval() {} },
  });
  p.push('a', 1);
  t += 121_000;
  await p.flush();
  assert.deepEqual(sent, []);
});

test('/data: an older write that hung is never put back over a newer one', async () => {
  const files = new Map();
  let holdFirst;
  const hold = new Promise((resolve) => (holdFirst = resolve));
  let opens = 0;
  const fs = {
    async open(path) {
      const n = ++opens;
      return {
        stat: async () => ({ isFile: () => true }),
        writeFile: async (text) => files.set(path, text),
        sync: async () => {
          if (n === 1) await hold;
        },
        close: async () => {},
      };
    },
    rename: async (from, to) => files.set(to, files.get(from)),
    unlink: async (path) => files.delete(path),
  };
  const store = fileStore('/x/state.json', { fs, queueWait: 5 });
  const first = store.save({ v: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.save({ v: 2 });
  holdFirst();
  await first;
  assert.equal(files.get('/x/state.json'), JSON.stringify({ v: 2 }));
});
