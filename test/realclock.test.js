// -----------------------------------------------------------------------------
// The app on a REAL moving clock (sped up 20 times) and the real local fake
// Aqara: values read every 2 minutes (never early, a little late under load
// at most), a turn off confirmed by the reads 5 s and 20 s later; nothing
// left running after stop.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AqaraApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { fakeAqara } from './helpers/fakeAqara.js';
import { realClock, waitFor } from './helpers/clock.js';
import { ACCOUNT, F, KEYS, SELECTOR, TOKENS, createdDevices, memoryLogger } from './helpers/app.js';

const SPEED = 20;

test('real clock: values every 2 minutes; a stop then its follow-up reads at 5 s and 20 s; nothing after stop', async (t) => {
  const clock = realClock({ speed: SPEED });
  const srv = await fakeAqara({ now: clock.now });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { region: 'ger', ...KEYS, account: ACCOUNT, ...TOKENS },
    devices: createdDevices(clock.now),
  });
  const app = new AqaraApp({
    gladys,
    logger: memoryLogger(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
    baseUrl: srv.url,
  });
  registerHandlers(gladys, app, memoryLogger());
  t.after(async () => {
    await Promise.race([app.stop(), new Promise((resolve) => setTimeout(resolve, 500))]);
    clock.close();
    await srv.close();
  });
  const polls = [];
  const original = app.poll.bind(app);
  app.poll = () => {
    polls.push(clock.monotonic());
    return original();
  };
  const reads = [];
  srv.routes['spec.query.trait'] = (r, s) => {
    reads.push({ at: clock.monotonic(), n: r.data.traits.length });
    return s.defaults['spec.query.trait'](r, s);
  };
  await gladys.connect();
  await waitFor(() => polls.length === 1 && reads.length === 1, 'first read', 3_000);
  const click = clock.monotonic();
  const outcome = await app.setValue({}, { external_id: F('lumi.plug0001', 'e1-onoff') }, 0);
  assert.match(outcome, /^Sent/);
  await waitFor(() => app.stops.size === 0, 'stop confirmed', 40_000 / SPEED + 3_000);
  const follow = reads.filter((r) => r.n === 1).map((r) => r.at - click);
  assert.ok(follow.length >= 1, 'a follow-up read');
  assert.ok(
    follow[0] >= TIMINGS.followUps[0] - 50 && follow[0] <= TIMINGS.followUps[0] + 1_500,
    `${follow[0]}`,
  );
  const period = TIMINGS.pollDefault;
  await waitFor(() => polls.length >= 3, 'three polls', (2 * period) / SPEED + 5_000);
  const gaps = polls.slice(1).map((v, i) => v - polls[i]);
  for (const gap of gaps.slice(0, 2)) {
    assert.ok(gap >= period * 0.98 && gap <= period * 1.5, `gap ${Math.round(gap)} ms`);
  }
  await app.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const count = srv.requests.length;
  await new Promise((resolve) => setTimeout(resolve, (2 * period) / SPEED));
  assert.equal(srv.requests.length, count, 'nothing sent after stop');
  assert.equal(clock.live, 0, 'no timer left');
});
