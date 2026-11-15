// -----------------------------------------------------------------------------
// The app end to end: the SDK's fake Gladys, a fake Aqara Open API on a real
// local HTTP server, a virtual clock that moves at every read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT,
  F,
  KEYS,
  TOKENS,
  answer,
  command,
  flush,
  setup,
  status,
  statesOf,
  until,
} from './helpers/app.js';
import { CODE, aqara, reply } from './helpers/fakeAqara.js';
import { memoryStore } from '../src/store.js';

const PLUG = F('lumi.plug0001', 'e1-onoff');
const LIGHT = F('lumi.light0001', 'e1-onoff');
const LEVEL = F('lumi.light0001', 'e1-brightness');
const CURTAIN = F('lumi.curt0001', 'e1-position');
const TEMP = F('lumi.weat0001', 'e1-temperature');
const DOOR = F('lumi.door0001', 'e1-contact');
const LOCK_SWITCH = F('aqara.lock0001', 'e2-onoff');

const secretsOf = (ctx) => [
  KEYS.app_key,
  ...Object.values(TOKENS),
  ctx.srv.tokens.access,
  ctx.srv.tokens.refresh,
  ACCOUNT,
  CODE,
];

function noSecret(ctx) {
  const texts = [
    ...ctx.logger.lines,
    JSON.stringify(ctx.store.data ?? {}),
    JSON.stringify(ctx.gladys.fake.connectionStatuses),
  ].join('\n');
  for (const s of secretsOf(ctx)) assert.ok(!texts.includes(s), `secret leaked: ${s.slice(0, 6)}…`);
}

test('first read: signed requests, devices, Discovery, values, status', async (t) => {
  const ctx = await setup(t);
  const { app, gladys, srv } = ctx;
  assert.equal(app.lastResult?.ok, true, JSON.stringify(app.lastResult));
  assert.equal(srv.count('query.device.info'), 1);
  assert.equal(srv.count('spec.query.qlinkmodel.config'), 2); // 6 models, 5 per call
  assert.equal(srv.count('spec.query.trait'), 1);
  const ext = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.ok(!ext.includes(F('lumi1.gw0001')), 'a hub without values is not listed');
  assert.equal(ext.length, 6);
  const lock = gladys.fake.discoveredDevices.find((d) => d.external_id === F('aqara.lock0001'));
  assert.deepEqual(
    lock.features.map((f) => [f.external_id, f.read_only]),
    [
      [F('aqara.lock0001', 'e0-battery'), true],
      [F('aqara.lock0001', 'e2-onoff'), true],
    ],
  );
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, PLUG), [1]);
  assert.deepEqual(statesOf(gladys, TEMP), [21.37]);
  assert.deepEqual(statesOf(gladys, F('lumi.weat0001', 'e1-humidity')), [48.2]);
  assert.deepEqual(statesOf(gladys, DOOR), [1]); // closed (Gladys: 1)
  assert.deepEqual(statesOf(gladys, CURTAIN), [100]);
  assert.match(status(gladys), /Connected to the Aqara Open API: 7 devices/);
  for (const r of srv.requests) {
    assert.equal(r.headers['content-type'], 'application/json');
    assert.match(r.headers['user-agent'], /^gladys-aqara/);
  }
  noSecret(ctx);
});

test('a turn off leaves at once, in a pause and over the budget, and is confirmed by the read 5 s later', async (t) => {
  const ctx = await setup(t);
  const { app, srv } = ctx;
  app.pauseUntil = app.monotonic() + 3_600_000;
  app.memory.budget = { day: app.today(), calls: 1_000_000 };
  const outcome = await answer(ctx, command(ctx, PLUG, 0));
  assert.match(outcome, /^Sent/);
  const writes = srv.of('spec.write.trait');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].data.traits[0], {
    deviceId: 'lumi.plug0001',
    endpointId: 1,
    functionCode: 'Output',
    traitCode: 'OnOff',
    value: false,
  });
  await until(ctx.clock, () => srv.count('spec.query.trait') >= 2, 'follow-up read');
  await until(ctx.clock, () => app.stops.size === 0, 'stop confirmed');
  assert.equal(srv.count('spec.write.trait'), 1);
});

test('a start is refused in a pause; nothing sent', async (t) => {
  const ctx = await setup(t);
  ctx.app.pauseUntil = ctx.app.monotonic() + 3_600_000;
  await assert.rejects(answer(ctx, command(ctx, PLUG, 1)), /slow down/);
  assert.equal(ctx.srv.count('spec.write.trait'), 0);
});

test('a stop contradicted by the reads is sent again, twice at most', async (t) => {
  const ctx = await setup(t);
  const { app, srv } = ctx;
  srv.applyWrites = false;
  await answer(ctx, command(ctx, PLUG, 0));
  await until(ctx.clock, () => app.stops.size === 0, 'stop ended', { step: 100, max: 120_000 });
  assert.equal(srv.count('spec.write.trait'), 3);
  assert.match(status(ctx.gladys), /Not confirmed by Aqara: turning off Kettle plug/);
});

test('a stop is not sent again over a change made after it (source date newer)', async (t) => {
  const ctx = await setup(t);
  const { app, srv, clock } = ctx;
  srv.routes['spec.write.trait'] = (r) => {
    // Accepted, then the user turns it on again in the Aqara app 2 s later.
    setTimeout(() => {}, 0);
    srv.data.values['lumi.plug0001|1|OnOff'] = { value: true, time: clock.now() + 2_000 };
    return { data: r.data.traits.map((x) => ({ ...x, code: 0 })) };
  };
  await answer(ctx, command(ctx, PLUG, 0));
  await until(ctx.clock, () => app.stops.size === 0, 'stop ended', { step: 100, max: 60_000 });
  assert.equal(srv.count('spec.write.trait'), 1);
});

test('the lock switch and the lock are never written', async (t) => {
  const ctx = await setup(t);
  await assert.rejects(answer(ctx, command(ctx, LOCK_SWITCH, 1)), /read only/);
  await assert.rejects(answer(ctx, command(ctx, LOCK_SWITCH, 0)), /read only/);
  assert.equal(ctx.srv.count('spec.write.trait'), 0);
});

test('turn on, brightness; brightness 0 is a turn off', async (t) => {
  const ctx = await setup(t);
  const { srv } = ctx;
  assert.match(await answer(ctx, command(ctx, LIGHT, 1)), /^Sent/);
  assert.match(await answer(ctx, command(ctx, LEVEL, 70)), /^Sent/);
  assert.match(await answer(ctx, command(ctx, LEVEL, 0)), /^Sent/);
  const traits = srv.of('spec.write.trait').map((r) => r.data.traits[0]);
  assert.deepEqual(
    traits.map((x) => [x.traitCode, x.value]),
    [
      ['OnOff', true],
      ['CurrentLevel', 70],
      ['OnOff', false],
    ],
  );
  await assert.rejects(answer(ctx, command(ctx, LEVEL, 101)), /Invalid value/);
  await assert.rejects(answer(ctx, command(ctx, TEMP, 1)), /unknown|Invalid|read only/);
});

test('positions are read only in v1: never written, open or close, even in a pause or without a read', async (t) => {
  const ctx = await setup(t);
  const { app, srv, gladys } = ctx;
  const curtain = gladys.fake.discoveredDevices.find((d) => d.external_id === F('lumi.curt0001'));
  assert.deepEqual(
    curtain.features.map((f) => [f.type, f.read_only]),
    [['position', true]],
  );
  assert.ok(!curtain.params.some((p) => p.name.startsWith('aqara_write_')));
  for (const v of [0, 30, 100])
    await assert.rejects(answer(ctx, command(ctx, CURTAIN, v)), /read only/);
  app.pauseUntil = app.monotonic() + 3_600_000;
  await assert.rejects(answer(ctx, command(ctx, CURTAIN, 0)), /read only/);
  app.devices.clear();
  app.descriptions.clear();
  await assert.rejects(answer(ctx, command(ctx, CURTAIN, 0)), /unknown/);
  assert.equal(srv.count('spec.write.trait'), 0);
});

test('a window opener or an untyped device with a position: read only all the same', async (t) => {
  const ctx = await setup(t, { connect: false, firstRead: false });
  const { srv, gladys, app, clock } = ctx;
  const m = srv.data.models['lumi.curtain.acn003'];
  delete m.types;
  delete m.endpoints[1].endpointTypes;
  await gladys.connect();
  await until(clock, () => app.lastResult?.ok, 'read');
  const curtain = gladys.fake.discoveredDevices.find((d) => d.external_id === F('lumi.curt0001'));
  assert.equal(curtain.features[0].read_only, true);
  await assert.rejects(answer(ctx, command(ctx, CURTAIN, 100)), /read only/);
  assert.equal(srv.count('spec.write.trait'), 0);
});

test('a close kept in /data from an older version is never replayed after a restart', async (t) => {
  const clock = (await import('./helpers/clock.js')).testClock({
    start: Date.UTC(2026, 10, 15, 10),
  });
  const data = {
    salt: '0'.repeat(32),
    stops: [
      { did: 'lumi.curt0001', key: 'e1-position', at: clock.now() - 30_000, sent: 1, attempts: 1 },
    ],
  };
  const ctx = await setup(t, { clock, data });
  await clock.advance(30_000);
  assert.equal(ctx.srv.count('spec.write.trait'), 0);
});

test('expired access token: renewed once, the request tried again, the new tokens saved in Gladys', async (t) => {
  const ctx = await setup(t, { firstRead: false, connect: false });
  const { srv, gladys, app } = ctx;
  srv.expiredToken = srv.tokens.access;
  srv.tokens = { access: 'ACCESS-other-0009', refresh: srv.tokens.refresh };
  await gladys.connect();
  await until(ctx.clock, () => app.lastResult !== undefined, 'read');
  assert.equal(app.lastResult.ok, true);
  assert.equal(srv.count('config.auth.refreshToken'), 1);
  assert.equal(gladys.fake.config.access_token, srv.tokens.access);
  assert.equal(gladys.fake.config.refresh_token, srv.tokens.refresh);
  assert.doesNotMatch(status(gladys), /could not be saved/);
  // A late echo of the old tokens does not bring them back.
  await gladys.fake.configUpdated({ ...ctx.config });
  assert.equal(app.tokens().refresh, srv.tokens.refresh);
  noSecret(ctx);
});

test('a refused renewal ends the authorization: kept in /data, no more reads, lifted by a new authorization', async (t) => {
  const ctx = await setup(t, { firstRead: false, connect: false });
  const { srv, gladys, app, clock } = ctx;
  srv.tokens = { access: 'ACCESS-other-0009', refresh: 'REFRESH-other-0009' };
  await gladys.connect();
  await until(clock, () => app.grantRefused(), 'refusal');
  assert.match(status(gladys), /authorize again/);
  assert.ok(ctx.store.data.grantRefused);
  const calls = srv.requests.length;
  await clock.advance(600_000);
  assert.equal(srv.requests.length, calls, 'nothing sent on its own');
  // A new authorization.
  assert.match((await answer(ctx, app.sendCode())).en, /verification code/);
  const result = await answer(ctx, app.authorize({ code: CODE }));
  assert.match(result.en, /Authorized/);
  await until(clock, () => app.lastResult?.ok, 'read after the authorization');
  assert.equal(app.grantRefused(), false);
  noSecret(ctx);
});

test('the verification code is asked on a click only, never twice within a minute, never at start', async (t) => {
  const ctx = await setup(t, { authorized: false });
  const { app, srv, clock } = ctx;
  await clock.advance(300_000);
  assert.equal(srv.count('config.auth.getAuthCode'), 0);
  assert.match(status(ctx.gladys), /Not authorized yet/);
  assert.match((await answer(ctx, app.sendCode())).en, /sends a verification code/);
  assert.match((await answer(ctx, app.sendCode())).en, /less than a minute/);
  assert.equal(srv.count('config.auth.getAuthCode'), 1);
  const body = srv.of('config.auth.getAuthCode')[0];
  assert.deepEqual(body.data, { account: ACCOUNT, accountType: 0, accessTokenValidity: '7d' });
  assert.equal(body.headers.accesstoken, undefined);
  await assert.doesNotReject(answer(ctx, app.authorize({ code: 'bad!' })));
  assert.match(
    (await answer(ctx, app.authorize({ code: '999999' }))).en,
    /refused the verification code/,
  );
  noSecret(ctx);
});

test('keys refused: kept in /data with a 6-bit mark, nothing sent again after a restart', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, config: { app_key: 'APPKEY-wrong-0009' } });
  assert.ok(ctx.app.keysRefused());
  assert.match(status(ctx.gladys), /refused the keys of the project/);
  assert.ok(Number.isInteger(store.data.keysRefused.mark) && store.data.keysRefused.mark < 64);
  const ctx2 = await setup(t, {
    store,
    config: { app_key: 'APPKEY-wrong-0009' },
    firstRead: false,
  });
  await ctx2.clock.advance(300_000);
  assert.equal(ctx2.srv.requests.length, 0);
});

test('429: a paused read, persisted, the stops still leave', async (t) => {
  const ctx = await setup(t, { firstRead: false, connect: false });
  const { srv, gladys, app, clock } = ctx;
  srv.routes['query.device.info'] = () => reply(429, 'slow down', { 'Retry-After': '120' });
  await gladys.connect();
  await until(clock, () => app.lastResult !== undefined, 'read');
  assert.ok(app.paused());
  assert.ok(ctx.store.data.pause.until > clock.now());
  const n = srv.requests.length;
  await clock.advance(60_000);
  assert.equal(srv.requests.length, n);
});

test('a code 429 in the envelope pauses too; a code 2008 on the descriptions does not refuse anything', async (t) => {
  const ctx = await setup(t, { firstRead: false, connect: false });
  const { srv, gladys, app, clock } = ctx;
  srv.routes['spec.query.qlinkmodel.config'] = () => aqara(2008, 'Permission denied');
  await gladys.connect();
  await until(clock, () => app.lastResult !== undefined, 'read');
  assert.equal(app.lastResult.ok, true);
  assert.equal(app.keysRefused() || app.grantRefused(), false);
  assert.ok(app.secondary.failures >= 1);
});

test('a measurement older than 2 h or already published is not published', async (t) => {
  const ctx = await setup(t, { firstRead: false, connect: false });
  const { srv, gladys, app, clock } = ctx;
  srv.data.values['lumi.weat0001|1|CurrentTemperature'] = {
    value: 19,
    time: clock.now() - 3 * 3_600_000,
  };
  await gladys.connect();
  await until(clock, () => app.lastResult !== undefined, 'read');
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, TEMP), []);
  assert.deepEqual(statesOf(gladys, F('lumi.weat0001', 'e1-humidity')), [48.2]);
  await clock.advance(130_000);
  await until(clock, () => srv.count('spec.query.trait') >= 2, 'second read');
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, F('lumi.weat0001', 'e1-humidity')), [48.2]);
});

test('an offline device publishes nothing; a text is never a measurement', async (t) => {
  const ctx = await setup(t, { firstRead: false, connect: false });
  const { srv, gladys, app, clock } = ctx;
  srv.data.values['lumi.weat0001|0|Reachable'] = { value: false, time: null };
  srv.data.values['lumi.plug0001|1|CurrentPower'] = { value: 'n/a', time: clock.now() };
  await gladys.connect();
  await until(clock, () => app.lastResult !== undefined, 'read');
  await flush(ctx);
  assert.deepEqual(statesOf(gladys, TEMP), []);
  assert.deepEqual(statesOf(gladys, F('lumi.plug0001', 'e1-power')), []);
  assert.deepEqual(statesOf(gladys, PLUG), [1]);
});

test('getConfig failing in connected: tried again, spaced, exact status, then the reads start', async (t) => {
  const ctx = await setup(t, { connect: false, firstRead: false });
  const { gladys, app, clock, srv } = ctx;
  // The first call is the SDK's own (connect); the app's next 2 fail.
  let calls = 0;
  const real = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (calls > 1 && calls <= 3) throw new Error('host API down');
    return real();
  };
  await gladys.connect();
  assert.match(status(gladys), /could not be read from Gladys; next try in 5 s/);
  await clock.advance(5_100);
  assert.match(status(gladys), /next try in 15 s/);
  assert.equal(srv.count('query.device.info'), 0);
  await until(clock, () => app.lastResult?.ok, 'read', { step: 100, max: 20_000 });
});

test('a /data that cannot be read: nothing overwritten, reads wait, stops still leave', async (t) => {
  const store = memoryStore();
  store.unreadable = true;
  const ctx = await setup(t, { store, firstRead: false });
  const { app, srv, clock } = ctx;
  await clock.advance(1_000);
  assert.equal(app.memoryState, 'unreadable');
  assert.equal(srv.count('query.device.info'), 0);
  // The stop: params of the created device, no read needed.
  assert.match(await answer(ctx, command(ctx, PLUG, 0)), /^Sent/);
  await assert.rejects(answer(ctx, command(ctx, PLUG, 1)), /cannot be read/);
  assert.equal(store.saves, 0);
  store.unreadable = false;
  await until(clock, () => app.lastResult?.ok, 'read once readable', { step: 500 });
});

test('the daily budget stops the reads; the status says so', async (t) => {
  const ctx = await setup(t, { config: { daily_calls: 200 } });
  const { app, srv, clock } = ctx;
  app.memory.budget = { day: app.today(), calls: 200 };
  const n = srv.requests.length;
  await clock.advance(600_000);
  assert.equal(srv.requests.length, n);
  assert.match(status(ctx.gladys), /daily budget of 200 API calls is spent/);
});
