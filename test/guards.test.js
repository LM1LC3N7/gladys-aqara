// -----------------------------------------------------------------------------
// The guards one by one (each has its mutant in scripts/mutants.mjs).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, answer, command, flush, setup, status, statesOf, until } from './helpers/app.js';
import { CODE, aqara, fakeAqara, reply } from './helpers/fakeAqara.js';
import { memoryStore } from '../src/store.js';
import { testClock } from './helpers/clock.js';
import { HttpError } from '../src/http.js';

const PLUG = F('lumi.plug0001', 'e1-onoff');
const LIGHT = F('lumi.light0001', 'e1-onoff');
const LEVEL = F('lumi.light0001', 'e1-brightness');
const TEMP = F('lumi.weat0001', 'e1-temperature');

test('a stop cuts a stuck read and leaves at once', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  srv.routes['spec.query.trait'] = () => 'hang';
  await clock.advance(120_100);
  await until(clock, () => srv.hanging === 1, 'stuck read', { step: 1 });
  const before = clock.elapsed;
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /^Sent/);
  assert.ok(clock.elapsed - before < 1_000, 'not after the read timeout');
  assert.equal(srv.count('spec.write.trait'), 1);
  // The stuck read was cut (not left to its 10 s timeout) and counts as nothing.
  await until(clock, () => srv.hanging === 0, 'read cut', { step: 5, max: 500 });
  assert.equal(app.lastRead, undefined);
  delete srv.routes['spec.query.trait'];
  void app;
});

test('a stop that cannot leave: tried again in its budget, then every 10 s, kept in /data, reported when lost', async (t) => {
  let down = true;
  const ctx = await setup(t, {
    inject: (url, opts) =>
      down && opts.body.includes('spec.write.trait')
        ? new HttpError('network', false, 'ECONNREFUSED')
        : undefined,
  });
  const { app, store, clock } = ctx;
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /Nothing sent yet/);
  assert.equal(app.stops.get('lumi.plug0001|e1-onoff').attempts, 2);
  assert.equal(store.data.stops.length, 1);
  await clock.advance(10_100);
  assert.equal(app.stops.get('lumi.plug0001|e1-onoff').attempts, 3);
  await until(clock, () => app.stops.size === 0, 'given up', { step: 500, max: 130_000 });
  assert.match(status(ctx.gladys), /Not confirmed by Aqara: turning off Kettle plug/);
  assert.equal(store.data.stops.length, 0);
  down = false;
});

test('a stop kept in /data is sent after a restart before any read; never when older than 2 minutes', async (t) => {
  const clock = testClock({ start: Date.UTC(2026, 10, 15, 10) });
  const now = clock.now();
  const data = {
    salt: '0'.repeat(32),
    stops: [
      { did: 'lumi.plug0001', key: 'e1-onoff', at: now - 30_000, sent: 0, attempts: 1 },
      { did: 'lumi.curt0001', key: 'e1-position', at: now - 300_000, sent: 0, attempts: 1 },
    ],
  };
  const srv = await fakeAqara({ now: clock.now });
  srv.routes['query.device.info'] = () => 'hang';
  const ctx = await setup(t, { clock, srv, data, firstRead: false });
  await until(clock, () => srv.count('spec.write.trait') === 1, 'stop sent');
  const w = srv.of('spec.write.trait')[0].data.traits[0];
  assert.deepEqual([w.deviceId, w.traitCode, w.value], ['lumi.plug0001', 'OnOff', false]);
  await clock.advance(30_000);
  assert.equal(srv.count('spec.write.trait'), 1);
  void ctx;
});

test('a turn on queued behind a stop of the same endpoint never leaves after it', async (t) => {
  const ctx = await setup(t);
  const { srv } = ctx;
  srv.routes['spec.write.trait'] = (r, s) =>
    r.data.traits[0].value === true
      ? new Promise((resolve) =>
          setTimeout(() => resolve(s.defaults['spec.write.trait'](r, s)), 50),
        )
      : s.defaults['spec.write.trait'](r, s);
  const on1 = command(ctx, LIGHT, 1);
  const on2 = command(ctx, LIGHT, 1); // queued behind on1
  const off = command(ctx, LIGHT, 0);
  // A pause comes too: the refusal of on2 still names its true cause, the stop.
  ctx.app.pauseUntil = ctx.app.monotonic() + 3_600_000;
  const results = await Promise.allSettled([answer(ctx, on1), answer(ctx, on2), answer(ctx, off)]);
  assert.equal(results[2].status, 'fulfilled');
  assert.match(String(results[1].reason?.message), /turn off came after it/);
  const values = srv.of('spec.write.trait').map((r) => r.data.traits[0].value);
  assert.equal(values.at(-1), false, JSON.stringify(values));
});

test('a start is checked again just before its send (a pause that came meanwhile)', async (t) => {
  const ctx = await setup(t);
  const { app, srv } = ctx;
  srv.routes['spec.write.trait'] = (r, s) =>
    new Promise((resolve) => setTimeout(() => resolve(s.defaults['spec.write.trait'](r, s)), 30));
  const first = command(ctx, LIGHT, 1);
  const second = command(ctx, LEVEL, 50);
  // The pause starts while the first is on its way.
  setTimeout(() => (app.pauseUntil = app.monotonic() + 3_600_000), 5);
  const results = await Promise.allSettled([answer(ctx, first), answer(ctx, second)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.match(String(results[1].reason?.message), /slow down/);
  assert.equal(srv.count('spec.write.trait'), 1);
});

test('starts are serialized per endpoint, never across devices', async (t) => {
  const ctx = await setup(t);
  const { srv } = ctx;
  let inflight = 0;
  let peak = 0;
  srv.routes['spec.write.trait'] = (r, s) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    return new Promise((resolve) =>
      setTimeout(() => {
        inflight -= 1;
        resolve(s.defaults['spec.write.trait'](r, s));
      }, 40),
    );
  };
  await Promise.all([answer(ctx, command(ctx, LIGHT, 1)), answer(ctx, command(ctx, PLUG, 1))]);
  assert.equal(peak, 2);
});

test('a start needs a device list younger than 15 minutes and an online device', async (t) => {
  const ctx = await setup(t);
  const { app, srv } = ctx;
  app.listAt = app.monotonic() - 16 * 60_000;
  await assert.rejects(answer(ctx, command(ctx, LIGHT, 1)), /too old/);
  app.listAt = app.monotonic();
  app.online.set('lumi.light0001', false);
  await assert.rejects(answer(ctx, command(ctx, LIGHT, 1)), /offline/);
  // Turning off an offline device still leaves.
  assert.match(await answer(ctx, command(ctx, LIGHT, 0)), /^Sent/);
  assert.equal(srv.count('spec.write.trait'), 1);
});

test('budget: reads stop, a start is refused, a stop still leaves', async (t) => {
  const ctx = await setup(t);
  const { app, srv } = ctx;
  app.memory.budget = { day: app.today(), calls: app.config.dailyCalls };
  await assert.rejects(answer(ctx, command(ctx, LIGHT, 1)), /daily budget/);
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /^Sent/);
  assert.equal(srv.count('spec.write.trait'), 1);
  assert.equal(app.budgetLeft(), 0);
});

test('the budget counts every call before it leaves and is kept in /data; a new day starts again', async (t) => {
  const ctx = await setup(t);
  const { app, store, srv } = ctx;
  assert.equal(app.memory.budget.calls, srv.requests.length);
  assert.equal(store.data.budget.day, '2026-11-15');
  app.memory.budget.day = '2026-11-14';
  assert.equal(app.budgetLeft(), app.config.dailyCalls);
});

test('the access token is renewed a day before it expires (known expiry of these tokens)', async (t) => {
  const ctx = await setup(t, { authorized: false, firstRead: false });
  const { app, srv, clock, gladys } = ctx;
  await answer(ctx, app.sendCode());
  await answer(ctx, app.authorize({ code: CODE }));
  await until(clock, () => app.lastResult?.ok, 'read');
  assert.equal(srv.count('config.auth.refreshToken'), 0);
  // 6 days and 1 hour later: within a day of the expiry.
  app.memory.token.expires = clock.now() + 23 * 3_600_000;
  await clock.advance(120_100);
  await until(clock, () => srv.count('config.auth.refreshToken') === 1, 'renewal');
  await until(clock, () => gladys.fake.config.refresh_token === srv.tokens.refresh, 'saved');
});

test('renewed tokens Gladys could not save are used meanwhile, and the status says so', async (t) => {
  const ctx = await setup(t, { firstRead: false, connect: false });
  const { app, srv, gladys, clock } = ctx;
  gladys.setConfig = async () => {
    throw new Error('host API down');
  };
  srv.expiredToken = srv.tokens.access;
  srv.tokens = { ...srv.tokens, access: 'ACCESS-other-0009' };
  await gladys.connect();
  await until(clock, () => app.lastResult !== undefined, 'read');
  assert.equal(app.lastResult.ok, true);
  assert.equal(app.tokens().access, srv.tokens.access);
  assert.match(status(gladys), /could not be saved in Gladys yet/);
});

test('new keys lift a refusal of the keys at once', async (t) => {
  const ctx = await setup(t, { config: { app_key: 'APPKEY-wrong-0009' } });
  const { app, gladys, clock } = ctx;
  assert.ok(app.keysRefused());
  await gladys.fake.configUpdated({ ...ctx.config, app_key: 'APPKEY-secret-0001' });
  await until(clock, () => app.lastResult?.ok, 'read with the new keys');
  assert.equal(app.keysRefused(), false);
});

test('the test button tries despite a mark kept from before a restart, and its success clears it', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, firstRead: false, connect: false });
  const { app, gladys, clock, srv } = ctx;
  await gladys.connect();
  await until(clock, () => app.lastResult?.ok, 'read');
  // A refusal mark that collides with the good keys.
  app.memory.keysRefused = { mark: app.keysMark() };
  assert.ok(app.keysRefused());
  await clock.advance(61_000);
  const n = srv.count('query.device.info');
  const text = await answer(ctx, app.testConnection());
  assert.match(text.en, /Connected: 7 devices/);
  assert.equal(srv.count('query.device.info'), n + 1);
  assert.equal(app.keysRefused(), false);
});

test('the code spacing holds across a restart (date in /data)', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, authorized: false });
  await answer(ctx, ctx.app.sendCode());
  await ctx.app.stop();
  const ctx2 = await setup(t, { store, authorized: false, clock: ctx.clock });
  assert.match((await answer(ctx2, ctx2.app.sendCode())).en, /less than a minute/);
  assert.equal(
    ctx.srv.count('config.auth.getAuthCode') + ctx2.srv.count('config.auth.getAuthCode'),
    1,
  );
});

test('a read that left before a command says nothing of the commanded value', async (t) => {
  const ctx = await setup(t);
  const { app, gladys, clock, srv } = ctx;
  await flush(ctx);
  const refs = app.valueRefs([app.devices.get('lumi.light0001')]);
  const left = app.monotonic();
  await answer(ctx, command(ctx, LIGHT, 1));
  await until(clock, () => srv.count('spec.query.trait') >= 2, 'follow-up read');
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, LIGHT), [0, 1]);
  // The old answer (off) of a read that left before the command arrives now.
  app.applyValues(
    refs,
    [
      {
        deviceId: 'lumi.light0001',
        endpointId: 1,
        traitCode: 'OnOff',
        value: false,
        time: clock.now(),
      },
    ],
    undefined,
    left,
  );
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, LIGHT), [0, 1]);
});

test('a read that left less than 3 s after a stop never sends it again (it may show the old state)', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  srv.applyWrites = false;
  await answer(ctx, command(ctx, PLUG, 0));
  const stop = app.stops.get('lumi.plug0001|e1-onoff');
  const refs = app.valueRefs([app.devices.get('lumi.plug0001')]);
  app.applyValues(
    refs,
    [
      {
        deviceId: 'lumi.plug0001',
        endpointId: 1,
        traitCode: 'OnOff',
        value: true,
        time: clock.now() - 60_000,
      },
    ],
    undefined,
    stop.lastSendAt + 1_000,
  );
  await clock.advance(100);
  assert.equal(srv.count('spec.write.trait'), 1);
  assert.equal(stop.resends, 0);
  assert.equal(app.stops.get('lumi.plug0001|e1-onoff'), stop);
});

test('a measurement is published once per source date (kept in /data)', async (t) => {
  const ctx = await setup(t);
  const { gladys, clock, store, srv } = ctx;
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, TEMP), [21.37]);
  assert.ok(store.data.seen[TEMP] > 0);
  srv.data.values['lumi.weat0001|1|CurrentTemperature'] = {
    value: 22,
    time: srv.data.values['lumi.weat0001|1|CurrentTemperature'].time,
  };
  await clock.advance(120_100);
  await until(clock, () => srv.count('spec.query.trait') >= 2, 'second read');
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, TEMP), [21.37]);
});

test('an HTTP 401/403 without the envelope, or an answer too large, is never a refusal', async (t) => {
  const ctx = await setup(t, { firstRead: false, connect: false });
  const { app, srv, gladys, clock } = ctx;
  srv.routes['query.device.info'] = () => reply(403, '<html>forbidden</html>');
  await gladys.connect();
  await until(clock, () => app.lastResult !== undefined, 'read');
  assert.equal(app.lastResult.kind, 'bad');
  assert.equal(app.keysRefused() || app.grantRefused(), false);
  srv.routes['query.device.info'] = () => ({ data: [], pad: 'x'.repeat(2 * 1024 * 1024) });
  app.lastRead = undefined;
  await clock.advance(120_100);
  await until(
    clock,
    () => srv.count('query.device.info') === 2 && app.lastResult?.kind === 'bad',
    'second read',
  );
  assert.equal(app.keysRefused() || app.grantRefused(), false);
});

test('a code 2004 then a refused renewal ends the authorization (never the keys)', async (t) => {
  const ctx = await setup(t, { firstRead: false, connect: false });
  const { app, srv, gladys, clock } = ctx;
  srv.routes['config.auth.refreshToken'] = () => aqara(2007, 'RefreshToken expired');
  srv.tokens = { access: 'ACCESS-other-0009', refresh: 'REFRESH-token-0001' };
  await gladys.connect();
  await until(clock, () => app.grantRefused(), 'refusal');
  assert.equal(app.keysRefused(), false);
  // A stop is not sent with a refused authorization: told at once.
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /refused the keys or the authorization/);
  assert.equal(srv.count('spec.write.trait'), 0);
});

test('the devices published carry no supported_options; features in Gladys units', async (t) => {
  const ctx = await setup(t);
  const all = ctx.gladys.fake.discoveredDevices.flatMap((d) => d.features);
  assert.ok(all.every((f) => f.supported_options === undefined));
  const pressure = all.find((f) => f.external_id === F('lumi.weat0001', 'e1-pressure'));
  assert.equal(pressure.unit, 'kPa');
});

test('a scene on 5 slow targets sets all 5; one target in 5xx stops none of the others', async (t) => {
  const ctx = await setup(t, { connect: false, firstRead: false });
  const { srv, gladys, app, clock } = ctx;
  for (const n of ['0002', '0003', '0004', '0005']) {
    srv.data.devices.push({
      did: `lumi.plug${n}`,
      model: 'lumi.plug.maeu01',
      modelType: 3,
      state: 1,
      deviceName: `Plug ${n}`,
    });
  }
  await gladys.connect();
  await until(clock, () => app.lastResult?.ok, 'read');
  srv.routes['spec.write.trait'] = (r, s) => {
    const did = r.data.traits[0].deviceId;
    if (did === 'lumi.plug0004') return reply(503, 'busy');
    const ms = 500 + (Number(did.slice(-1)) % 5) * 100;
    return new Promise((resolve) =>
      setTimeout(() => resolve(s.defaults['spec.write.trait'](r, s)), ms),
    );
  };
  const targets = [
    F('lumi.plug0001', 'e1-onoff'),
    F('lumi.plug0002', 'e1-onoff'),
    F('lumi.plug0003', 'e1-onoff'),
    F('lumi.light0001', 'e1-onoff'),
    F('lumi.plug0005', 'e1-onoff'),
  ];
  const values = [0, 1, 1, 1, 1];
  const failing = command(ctx, F('lumi.plug0004', 'e1-onoff'), 1);
  const results = await Promise.allSettled([
    answer(ctx, failing),
    ...targets.map((id, i) => answer(ctx, command(ctx, id, values[i]))),
  ]);
  for (const r of results.slice(1)) assert.equal(r.status, 'fulfilled', String(r.reason));
  const written = new Set(srv.of('spec.write.trait').map((r) => r.data.traits[0].deviceId));
  for (const did of [
    'lumi.plug0001',
    'lumi.plug0002',
    'lumi.plug0003',
    'lumi.light0001',
    'lumi.plug0005',
  ])
    assert.ok(written.has(did), did);
  // The 5xx paused nothing: the next command still leaves.
  assert.equal(app.paused(), false);
  assert.match(await answer(ctx, command(ctx, F('lumi.plug0002', 'e1-onoff'), 0)), /^Sent/);
});
