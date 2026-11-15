// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake Aqara Open API on a real local
// HTTP server, a virtual clock and a /data in memory. Every wait is bounded:
// a test fails, never hangs, even under a mutant.
//
// The virtual clock never moves while a request of the app is on its way
// (`clock.idle`), except a request the fake holds on purpose ('hang'): a
// timeout of the app never races the real network.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AqaraApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { buildDevice, featuresOf, parseDescription } from '../../src/model.js';
import { memoryStore } from '../../src/store.js';
import { request as httpRequest } from '../../src/http.js';
import { ACCOUNT, KEYS, defaultData, fakeAqara } from './fakeAqara.js';
import { settle, testClock, waitFor } from './clock.js';

export const SELECTOR = 'aqara';
export { ACCOUNT, KEYS };

/** A memory logger (every line kept). */
export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
}

/** `F('lumi.plug0001', 'e1-onoff')` -> the external id of a feature (or of the device without key). */
export const F = (did, key) =>
  `ext:${SELECTOR}:device:${did.replace('.', '-')}${key ? `:${key}` : ''}`;

/** The devices created in Gladys by default: every device of the fake that has features. */
export function createdDevices(now = () => Date.UTC(2026, 10, 15, 10)) {
  const g = createFakeGladys({ selector: SELECTOR });
  const data = defaultData(now);
  const out = [];
  for (const d of data.devices) {
    const description = parseDescription(data.models[d.model]);
    const built = buildDevice(
      g,
      { did: d.did, model: d.model, name: d.deviceName },
      featuresOf(description),
    );
    if (built) out.push(built);
  }
  return out;
}

export const TOKENS = { access_token: 'ACCESS-token-0001', refresh_token: 'REFRESH-token-0001' };

export async function setup(t, options = {}) {
  const clock = options.clock ?? testClock({ start: Date.UTC(2026, 10, 15, 10) });
  const srv = options.srv ?? (await fakeAqara({ now: clock.now }));
  let pending = 0;
  const request = (url, opts) => {
    const injected = options.inject?.(url, opts);
    if (injected) return Promise.reject(injected);
    pending += 1;
    return httpRequest(url, opts).finally(() => {
      pending -= 1;
    });
  };
  clock.busy ??= [];
  clock.busy.push(() => pending - srv.hanging > 0);
  clock.idle ??= () => !clock.busy.some((busy) => busy());
  const store = options.store ?? memoryStore(options.data ?? null);
  const config = {
    region: 'ger',
    ...KEYS,
    account: ACCOUNT,
    ...(options.authorized === false ? {} : TOKENS),
    ...options.config,
  };
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: options.devices ?? createdDevices(clock.now),
  });
  const logger = options.logger ?? memoryLogger();
  const app = new AqaraApp({
    gladys,
    logger,
    now: options.wallOffset ? () => clock.now() + options.wallOffset.ms : clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    request,
    baseUrl: srv.url,
    ...options.app,
  });
  registerHandlers(gladys, app, logger);
  t.after(async () => {
    await Promise.race([app.stop(), new Promise((resolve) => setTimeout(resolve, 300))]);
    await srv.close();
  });
  const ctx = { app, gladys, srv, clock, store, config, logger, pending: () => pending };
  if (options.connect !== false) {
    await gladys.connect();
    if (options.firstRead !== false)
      await until(
        clock,
        () => app.lastResult !== undefined || app.memoryState !== 'ok' || !app.ready(),
        'first read',
      );
  }
  return ctx;
}

/** Advances the virtual clock until `condition()` (real I/O runs in between), bounded. */
export async function until(clock, condition, what, { step = 10, max = 30_000 } = {}) {
  for (let spent = 0; spent <= max; spent += step) {
    await settle(3);
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await clock.advance(step);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The answer of a call, the virtual clock run until it comes (bounded). */
export async function answer(ctx, promise, { step = 5, max = 30_000 } = {}) {
  const box = { done: false };
  const settled = promise.then(
    (value) => {
      box.done = true;
      return value;
    },
    (err) => {
      box.done = true;
      throw err;
    },
  );
  settled.catch(() => {});
  await until(ctx.clock, () => box.done, 'answer', { step, max });
  return settled;
}

/** A command as Gladys sends it (the created device and the feature), its outcome text or its refusal. */
export function command(ctx, featureId, value) {
  const device = (ctx.gladys.devices ?? []).find((d) =>
    (d.features ?? []).some((f) => f.external_id === featureId),
  );
  return ctx.app.setValue(device ?? {}, { external_id: featureId }, value);
}

/** The states published to Gladys for one feature (values in order). */
export const statesOf = (gladys, featureId) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === featureId).map((s) => s.state);

/** The last status of the integration, in English. */
export const status = (gladys) => gladys.fake.connectionStatus?.message?.en ?? '';

/** Lets the publisher flush (1 s of virtual time). */
export const flush = (ctx) => ctx.clock.advance(1_100);

export { settle, waitFor };
