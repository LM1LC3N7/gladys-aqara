// -----------------------------------------------------------------------------
// Pure parts: the signature of the documentation, the return codes, the
// configuration, the trait model, the values, /data and the bounded HTTP.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AqaraApi, kindOfCode, retryAfterMs, sign } from '../src/api.js';
import { normalizeConfig } from '../src/config.js';
import { request } from '../src/http.js';
import {
  boolOf,
  buildDevice,
  commandOf,
  contactMeaning,
  decimalOf,
  didOfPlatform,
  featureFromParams,
  featuresOf,
  parseDescription,
  parseDevicePage,
  parseExternalId,
  parseModels,
  platformOf,
  valueOf,
} from '../src/model.js';
import { emptyMemory, mark, normalizeMemory, serializeMemory } from '../src/store.js';
import { defaultModels } from './helpers/fakeAqara.js';

test('the Sign of the documentation example (opendoc.aqara.com, Sign Generation Rules)', () => {
  assert.equal(
    sign({
      accessToken: '532cad73c5493193d63d367016b98b27',
      appId: '4e693d54d75db580a56d1263',
      // The Java demo of the page (its step-by-step text shows a "k." prefix that its hash does not have).
      keyId: '78784564654feda454557',
      nonce: 'C6wuzd0Qguxzelhb',
      time: '1618914078668',
      appKey: 'gU7Qtxi4dWnYAdmudyxni52bWZ58b8uN',
    }),
    'bfd8dd0e7c108353e6740d81e05982d8',
  );
  // Without an access token, it is left out of the signed text.
  const without = sign({ appId: 'a', keyId: 'k', nonce: 'n', time: '1', appKey: 'K' });
  assert.match(without, /^[0-9a-f]{32}$/);
});

test('the headers of a request: no Accesstoken without a token, no CR/LF anywhere', () => {
  const api = new AqaraApi(
    { region: 'ger', keys: { appId: 'app0001', keyId: 'K.1', appKey: 'secretkey1' } },
    { now: () => 1_700_000_000_000 },
  );
  const h = api.headers(undefined);
  assert.equal(h.Accesstoken, undefined);
  assert.equal(h.Time, '1700000000000');
  assert.equal(api.url, 'https://open-ger.aqara.com/v3.0/open/api');
  const h2 = api.headers('token-0001');
  assert.equal(h2.Accesstoken, 'token-0001');
  assert.notEqual(h.Nonce, h2.Nonce);
  for (const v of Object.values(h2)) assert.doesNotMatch(v, /[\r\n]/);
  assert.ok(!Object.values(h2).includes('secretkey1'), 'the App Key never travels');
});

test('return codes: keys, tokens, refresh, rate, server, device, permission are told apart', () => {
  assert.equal(kindOfCode(106), 'keys');
  assert.equal(kindOfCode(2002), 'keys');
  assert.equal(kindOfCode(108), 'expired');
  assert.equal(kindOfCode(2004), 'token');
  assert.equal(kindOfCode(2007), 'refresh');
  assert.equal(kindOfCode(429), 'rate');
  assert.equal(kindOfCode(104), 'server');
  assert.equal(kindOfCode(602), 'device');
  assert.equal(kindOfCode(2008), 'permission');
  assert.equal(kindOfCode(403), 'permission');
  assert.equal(kindOfCode(817), 'code-too-often');
  assert.equal(kindOfCode(12345), 'refused');
  assert.equal(retryAfterMs({ 'retry-after': '30' }), 30_000);
  assert.equal(retryAfterMs({ 'retry-after': 'soon' }), undefined);
});

test('configuration: invalid values reported by key only, bounds, CR/LF refused', () => {
  const c = normalizeConfig({
    region: 'ger',
    app_id: 'app0001',
    key_id: 'K.1',
    app_key: 'secret\r\nX: y',
    account: 'me@example.com',
    access_token: 'tok en',
    refresh_token: 'REFRESH-0001',
    poll_seconds: 5,
    daily_calls: 10,
  });
  assert.deepEqual(c.errors, ['app_key']);
  assert.deepEqual(c.tokenErrors, ['access_token']);
  assert.equal(c.keys, undefined);
  assert.equal(c.tokens, undefined);
  assert.equal(c.pollMs, 60_000);
  assert.equal(c.dailyCalls, 200);
  assert.ok(!JSON.stringify(c.errors).includes('secret'));
  assert.deepEqual(normalizeConfig({ region: 'mars' }).errors.includes('region'), true);
  assert.equal(normalizeConfig({ account: '+33612345678' }).account, '+33612345678');
  assert.equal(normalizeConfig({ account: 'not an account' }).accountInvalid, true);
  assert.equal(normalizeConfig({ poll_seconds: 99999 }).pollMs, 3_600_000);
});

test('ids: did <-> platform id reversible; external ids parsed exactly', () => {
  assert.equal(platformOf('lumi.158d000488d874'), 'lumi-158d000488d874');
  assert.equal(didOfPlatform('lumi-158d000488d874'), 'lumi.158d000488d874');
  assert.equal(didOfPlatform('virtual2-07737309957642'), 'virtual2.07737309957642');
  assert.equal(didOfPlatform('a-b-c'), 'a.b-c');
  assert.deepEqual(parseExternalId('ext:aqara:device:lumi-abc:e1-onoff', 'ext:aqara:'), {
    did: 'lumi.abc',
    key: 'e1-onoff',
  });
  for (const bad of [
    'ext:aqara:device:lumi-abc:e1-onoff:x',
    'ext:other:device:lumi-abc:e1-onoff',
    'ext:aqara:device:lumi.abc:e1-onoff',
    'ext:aqara:device:lumi-abc:e01-onoff',
    'ext:aqara:device:../x:e1-onoff',
    'ext:aqara:device:lumi-abc',
  ]) {
    assert.equal(parseExternalId(bad, 'ext:aqara:'), undefined, bad);
  }
});

test('strict values: text, empty, null are unknown, never 0', () => {
  assert.equal(decimalOf(''), undefined);
  assert.equal(decimalOf(null), undefined);
  assert.equal(decimalOf('12.5'), 12.5);
  assert.equal(decimalOf('1e3'), undefined);
  assert.equal(boolOf('yes'), undefined);
  assert.equal(boolOf('0'), false);
  assert.equal(boolOf(true), true);
});

test('device list page: bad entries skipped, names cleaned and bounded', () => {
  const page = parseDevicePage({
    data: [
      { did: 'lumi.ok01', model: 'lumi.plug.v1', state: 1, deviceName: 'Plug\u0000\n one' },
      { did: 'bad did', model: 'x' },
      { did: 'lumi.ok02', model: 'lumi.plug.v1', state: '0', deviceName: 'x'.repeat(200) },
      { did: 'lumi.ok03', model: '../etc' },
      null,
    ],
    totalCount: 5,
  });
  assert.deepEqual(
    page.devices.map((d) => [d.did, d.name.length, d.online]),
    [
      ['lumi.ok01', 8, true],
      ['lumi.ok02', 60, false],
    ],
  );
  assert.equal(page.devices[0].name, 'Plug one');
  assert.equal(parseDevicePage({ data: 'x' }), undefined);
});

test('trait model: both spellings of the API, unit checked, locks never commandable', () => {
  const models = parseModels({ data: defaultModels() });
  const keys = (model) => featuresOf(models.get(model)).map((f) => [f.key, f.writable]);
  assert.deepEqual(keys('lumi.plug.maeu01'), [
    ['e1-onoff', true],
    ['e1-power', false],
    ['e1-voltage', false],
  ]);
  assert.deepEqual(keys('lumi.curtain.acn003'), [['e1-position', false]]);
  assert.deepEqual(keys('aqara.lock.wbzac1'), [
    ['e0-battery', false],
    ['e2-onoff', false],
  ]);
  // A temperature in another unit (or a scaled integer) is left out.
  const desc = parseDescription({
    endpoints: [
      {
        endpointId: 1,
        deviceType: 'TemperatureSensor',
        functions: [
          {
            functionCode: 'T',
            traits: [
              { traitCode: 'CurrentTemperature', parameter: { readable: true, unit: '°F' } },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(featuresOf(desc), []);
  // __proto__ and huge lists are harmless.
  const evil = parseModels({
    data: JSON.parse('{"__proto__": {"endpoints": []}, "m.x": {"endpoints": "x"}}'),
  });
  assert.equal(evil.size, 0);
  assert.equal({}.endpoints, undefined);
});

test('values: ranges, the contact meaning of the enum labels, the Gladys opening convention', () => {
  const contact = { kind: 'binary', label: 'contact', openWhenTrue: true };
  assert.equal(valueOf(contact, true), 0); // open
  assert.equal(valueOf(contact, '0'), 1); // closed
  assert.equal(valueOf({ ...contact, openWhenTrue: false }, true), 1);
  assert.equal(
    contactMeaning([
      { key: 'Close', value: '1' },
      { key: 'Open', value: '0' },
    ]),
    false,
  );
  assert.equal(contactMeaning([{ key: 'Open', value: '1' }]), true);
  assert.equal(contactMeaning([]), true);
  const temp = featuresOf(parseModels({ data: defaultModels() }).get('lumi.weather.v1')).find(
    (f) => f.label === 'temperature',
  );
  assert.equal(valueOf(temp, '21.374'), 21.37);
  assert.equal(valueOf(temp, 2137), undefined); // a scaled value is never published
  assert.equal(valueOf(temp, 'n/a'), undefined);
  assert.equal(valueOf({ kind: 'position' }, 101), undefined);
  assert.equal(valueOf({ kind: 'onoff' }, 'true'), 1);
});

test('commands: protective turn off and close, bounded values, brightness 0 needs the on/off', () => {
  const onoff = {
    kind: 'onoff',
    key: 'e1-onoff',
    endpoint: 1,
    functionCode: 'Output',
    traitCode: 'OnOff',
  };
  const level = {
    kind: 'brightness',
    key: 'e1-brightness',
    endpoint: 1,
    functionCode: 'L',
    traitCode: 'CurrentLevel',
  };
  const position = {
    kind: 'position',
    key: 'e1-position',
    endpoint: 1,
    write: { functionCode: 'W', traitCode: 'TargetPositionPercentage' },
  };
  assert.equal(commandOf(onoff, 0).protective, true);
  assert.equal(commandOf(onoff, 0).value, false);
  assert.equal(commandOf(onoff, 1).protective, false);
  assert.equal(commandOf(onoff, 2), undefined);
  assert.equal(commandOf(onoff, NaN), undefined);
  assert.equal(commandOf(position, 0).protective, true);
  assert.equal(commandOf(position, 50).protective, false);
  assert.equal(commandOf(position, -1), undefined);
  assert.equal(commandOf(level, 0, []), undefined);
  assert.equal(commandOf(level, 0, [onoff]).feature, onoff);
  assert.equal(commandOf(level, 55.5), undefined);
});

test('the device params tell where a stop is written (no read needed)', () => {
  const g = createFakeGladys({ selector: 'aqara' });
  const models = parseModels({ data: defaultModels() });
  const device = buildDevice(
    g,
    { did: 'lumi.curt0001', model: 'lumi.curtain.acn003', name: 'Curtain' },
    featuresOf(models.get('lumi.curtain.acn003')),
  );
  // Positions are read only in v1: no param, nothing written even right after a restart.
  assert.equal(featureFromParams(device, 'e1-position'), undefined);
  assert.ok(!device.params.some((p) => p.name.startsWith('aqara_write_')));
  assert.equal(featureFromParams(device, 'e1-onoff'), undefined);
  const plug = buildDevice(
    g,
    { did: 'lumi.plug0001', model: 'lumi.plug.maeu01', name: 'Plug' },
    featuresOf(models.get('lumi.plug.maeu01')),
  );
  const onoff = featureFromParams(plug, 'e1-onoff');
  assert.deepEqual([onoff.functionCode, onoff.traitCode], ['Output', 'OnOff']);
  assert.equal(
    featureFromParams({ params: [{ name: 'aqara_write_e1-onoff', value: 'a/b/c' }] }, 'e1-onoff'),
    undefined,
  );
  // A read-only feature has no param: a lock is never written, even right after a restart.
  const lock = buildDevice(
    g,
    { did: 'aqara.lock0001', model: 'aqara.lock.wbzac1', name: 'Lock' },
    featuresOf(models.get('aqara.lock.wbzac1')),
  );
  assert.equal(featureFromParams(lock, 'e2-onoff'), undefined);
});

test('/data: only known keys, future dates dropped, a mark of 6 bits, nothing secret', () => {
  const now = Date.UTC(2026, 10, 15);
  const raw = JSON.parse(
    JSON.stringify({
      salt: 'a'.repeat(32),
      lastAttempt: now + 60_000,
      pause: { until: now + 10 * 3_600_000, failures: 3 },
      keysRefused: { mark: 99 },
      grantRefused: { mark: 7 },
      stops: [
        { did: 'lumi.x1', key: 'e1-onoff', at: now - 1_000, sent: 1, attempts: 1 },
        { did: 'lumi.x1', key: 'e1-brightness', at: now - 1_000 },
        { did: 'lumi.x2', key: 'e1-onoff', at: now - 600_000 },
      ],
      seen: { 'ext:aqara:device:lumi-x1:e1-temperature': now - 1_000, __proto__: 5, bad: now },
      budget: { day: '2026-11-15', calls: 12 },
    }),
  );
  const m = normalizeMemory(raw, now);
  assert.equal(m.lastAttempt, undefined);
  assert.equal(m.pause.until, 0);
  assert.equal(m.keysRefused, undefined);
  assert.deepEqual(m.grantRefused, { mark: 7 });
  assert.deepEqual(
    m.stops.map((s) => s.key),
    ['e1-onoff'],
  );
  assert.equal(m.seen.size, 1);
  assert.equal(m.budget.calls, 12);
  const out = serializeMemory(m);
  assert.deepEqual(Object.keys(out).sort(), [
    'budget',
    'format',
    'grantRefused',
    'pause',
    'salt',
    'seen',
    'stops',
  ]);
  const e = emptyMemory();
  assert.ok(mark(e.salt, 'x') >= 0 && mark(e.salt, 'x') < 64);
});

test('the request is cut past its size limit and bounded in time', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/big') {
      // Chunked, no Content-Length: cut while reading.
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      res.write(Buffer.alloc(64 * 1024, 'a'));
      res.write(Buffer.alloc(64 * 1024, 'a'), () => res.end(Buffer.alloc(64 * 1024, 'a')));
    } else if (req.url === '/len') {
      res.writeHead(200, { 'Content-Length': String(10 * 1024 * 1024) });
      res.write('x');
    }
    // '/silent' never answers
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(request(`${base}/big`, { timeoutMs: 5_000, maxBytes: 100_000 }), {
    kind: 'too-large',
  });
  await assert.rejects(request(`${base}/len`, { timeoutMs: 5_000, maxBytes: 100_000 }), {
    kind: 'too-large',
  });
  await assert.rejects(request(`${base}/silent`, { timeoutMs: 200 }), {
    kind: 'timeout',
    sent: true,
  });
});
