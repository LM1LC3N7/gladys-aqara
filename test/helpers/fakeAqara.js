// -----------------------------------------------------------------------------
// A fake Aqara Open API on a real local HTTP server (127.0.0.1, free port):
// POST /v3.0/open/api with `{ intent, data }`, the Sign header checked
// against the test keys (code 106 when wrong), the access token checked
// (code 108 when expired, 2004 when unknown). Routes by intent:
// `srv.routes[intent] = (record, srv) => answer`, an answer being an object
// (the `result` of a code 0), `aqara(code)` (an error envelope),
// `reply(status, body, headers)`, 'hang' (never answers until `release()`),
// or 'drop' (closes the socket). Every request is recorded (`requests`,
// `count(intent)`); the Date header is the one of the injected clock.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { createHash } from 'node:crypto';

export const reply = (status, body, headers = {}) => ({ __reply: true, status, body, headers });
export const aqara = (code, message = 'error') =>
  reply(200, { code, message, requestId: 'x', result: null });

export const KEYS = {
  app_id: 'appid0123456789abcdef',
  key_id: 'K.0123456789',
  app_key: 'APPKEY-secret-0001',
};
export const ACCOUNT = 'someone@example.com';
export const CODE = '123456';

const param = (readable, writable, extra = {}) => ({
  readable,
  writable,
  subscribable: true,
  ...extra,
});
const trait = (traitCode, parameter) => ({ traitId: 1, traitCode, parameter });
const fn = (functionCode, traits) => ({ functionId: 1, functionCode, traits });
const root = () => ({
  endpointId: 0,
  deviceType: 'Root',
  functions: [fn('BasicInformation', [trait('Reachable', param(true, false, { type: 'Bool' }))])],
});

/** The descriptions by model (spec.query.qlinkmodel.config). */
export function defaultModels() {
  return {
    'lumi.plug.maeu01': {
      model: 'lumi.plug.maeu01',
      deviceTypesList: ['Outlet'],
      endpoints: [
        root(),
        {
          endpointId: 1,
          deviceType: 'Outlet',
          functions: [
            fn('Output', [trait('OnOff', param(true, true, { type: 'Bool' }))]),
            fn('EnergyManagement', [
              trait('CurrentPower', param(true, false, { type: 'Float', unit: 'W' })),
              trait('CurrentVoltage', param(true, false, { type: 'Float', unit: 'V' })),
            ]),
          ],
        },
      ],
    },
    'aqara.light.acn014': {
      model: 'aqara.light.acn014',
      deviceTypesList: ['Light'],
      endpoints: [
        root(),
        {
          endpointId: 1,
          deviceType: 'Light',
          functions: [
            fn('Output', [trait('OnOff', param(true, true, { type: 'Bool' }))]),
            fn('LevelControl', [
              trait(
                'CurrentLevel',
                param(true, true, { type: 'Integer', unit: '%', min: 1, max: 100 }),
              ),
            ]),
          ],
        },
      ],
    },
    'lumi.curtain.acn003': {
      model: 'lumi.curtain.acn003',
      types: ['Curtain'],
      endpoints: [
        root(),
        {
          endpointId: 1,
          endpointTypes: ['WindowCovering'],
          functions: [
            fn('WindowCovering', [
              trait('CurrentPositionPercentage', {
                readable: true,
                writable: false,
                format: 'Integer',
                unit: '%',
              }),
              trait('TargetPositionPercentage', {
                readable: false,
                writable: true,
                format: 'Integer',
                unit: '%',
              }),
            ]),
          ],
        },
      ],
    },
    'lumi.weather.v1': {
      model: 'lumi.weather.v1',
      deviceTypesList: ['TemperatureSensor', 'HumiditySensor'],
      endpoints: [
        {
          ...root(),
          functions: [
            ...root().functions,
            fn('PowerSource', [
              trait('BatPercentRemaining', param(true, false, { type: 'Integer', unit: '%' })),
            ]),
          ],
        },
        {
          endpointId: 1,
          deviceType: 'TemperatureSensor',
          functions: [
            fn('TemperatureMeasurement', [
              trait('CurrentTemperature', param(true, false, { type: 'Float', unit: '°C' })),
            ]),
            fn('HumidityMeasurement', [
              trait('CurrentHumidity', param(true, false, { type: 'Float', unit: '%' })),
            ]),
            fn('PressureMeasurement', [
              trait('CurrentPressure', param(true, false, { type: 'Float', unit: 'kPa' })),
            ]),
          ],
        },
      ],
    },
    'lumi.magnet.agl02': {
      model: 'lumi.magnet.agl02',
      deviceTypesList: ['ContactSensor'],
      endpoints: [
        root(),
        {
          endpointId: 1,
          deviceType: 'ContactSensor',
          functions: [
            fn('BooleanState', [
              trait(
                'ContactSensorState',
                param(true, false, {
                  type: 'Bool',
                  supportedValues: [
                    { key: 'Close', value: '0' },
                    { key: 'Open', value: '1' },
                  ],
                }),
              ),
            ]),
          ],
        },
      ],
    },
    'aqara.lock.wbzac1': {
      model: 'aqara.lock.wbzac1',
      deviceTypesList: ['DoorLock'],
      endpoints: [
        {
          ...root(),
          functions: [
            ...root().functions,
            fn('PowerSource', [
              trait('BatPercentRemaining', param(true, false, { type: 'Integer', unit: '%' })),
            ]),
          ],
        },
        {
          endpointId: 1,
          deviceType: 'DoorLock',
          functions: [
            fn('DoorLock', [
              trait('LockState', param(true, false, { type: 'Enum' })),
              trait('RemoteUnlock', param(true, true, { type: 'Bool' })),
            ]),
          ],
        },
        {
          endpointId: 2,
          deviceType: 'Switch',
          functions: [fn('Output', [trait('OnOff', param(true, true, { type: 'Bool' }))])],
        },
      ],
    },
  };
}

export function defaultData(now) {
  const t = now() - 60_000;
  const v = (value, time = t) => ({ value, time });
  return {
    devices: [
      {
        did: 'lumi1.gw0001',
        parentDid: '',
        model: 'lumi.gateway.agl004',
        modelType: 1,
        state: 1,
        deviceName: 'Hub M3',
      },
      {
        did: 'lumi.plug0001',
        parentDid: 'lumi1.gw0001',
        model: 'lumi.plug.maeu01',
        modelType: 3,
        state: 1,
        deviceName: 'Kettle plug',
      },
      {
        did: 'lumi.light0001',
        parentDid: 'lumi1.gw0001',
        model: 'aqara.light.acn014',
        modelType: 3,
        state: 1,
        deviceName: 'Desk lamp',
      },
      {
        did: 'lumi.curt0001',
        parentDid: 'lumi1.gw0001',
        model: 'lumi.curtain.acn003',
        modelType: 3,
        state: 1,
        deviceName: 'Curtain',
      },
      {
        did: 'lumi.weat0001',
        parentDid: 'lumi1.gw0001',
        model: 'lumi.weather.v1',
        modelType: 3,
        state: 1,
        deviceName: 'Living room',
      },
      {
        did: 'lumi.door0001',
        parentDid: 'lumi1.gw0001',
        model: 'lumi.magnet.agl02',
        modelType: 3,
        state: 1,
        deviceName: 'Front door',
      },
      {
        did: 'aqara.lock0001',
        parentDid: 'lumi1.gw0001',
        model: 'aqara.lock.wbzac1',
        modelType: 3,
        state: 1,
        deviceName: 'Door lock',
      },
    ],
    models: defaultModels(),
    values: {
      'lumi.plug0001|0|Reachable': v(true, null),
      'lumi.plug0001|1|OnOff': v(true),
      'lumi.plug0001|1|CurrentPower': v('1500.5'),
      'lumi.plug0001|1|CurrentVoltage': v(230.1),
      'lumi.light0001|0|Reachable': v(true, null),
      'lumi.light0001|1|OnOff': v(false),
      'lumi.light0001|1|CurrentLevel': v(40),
      'lumi.curt0001|0|Reachable': v(true, null),
      'lumi.curt0001|1|CurrentPositionPercentage': v(100),
      'lumi.weat0001|0|Reachable': v(true, null),
      'lumi.weat0001|0|BatPercentRemaining': v(87),
      'lumi.weat0001|1|CurrentTemperature': v(21.37),
      'lumi.weat0001|1|CurrentHumidity': v('48.2'),
      'lumi.weat0001|1|CurrentPressure': v(101.3),
      'lumi.door0001|0|Reachable': v(true, null),
      'lumi.door0001|1|ContactSensorState': v(false),
      'aqara.lock0001|0|Reachable': v(true, null),
      'aqara.lock0001|0|BatPercentRemaining': v(55),
      'aqara.lock0001|2|OnOff': v(true),
    },
  };
}

/** What a write sets: the trait read back for a written trait. */
const READ_BACK = {
  OnOff: 'OnOff',
  CurrentLevel: 'CurrentLevel',
  TargetPositionPercentage: 'CurrentPositionPercentage',
};

export async function fakeAqara({ now = Date.now, latencyMs = 0 } = {}) {
  const data = defaultData(now);
  const requests = [];
  const held = new Set();
  let waiting = 0;
  let rotation = 0;
  const srv = {
    data,
    requests,
    latencyMs,
    /** Writes applied to the values (false: Aqara accepts and the device does nothing). */
    applyWrites: true,
    tokens: { access: 'ACCESS-token-0001', refresh: 'REFRESH-token-0001' },
    expiresIn: 7 * 86_400,
    /** Requests waiting on a 'hang' route (the virtual clock may move meanwhile). */
    get hanging() {
      return held.size + waiting;
    },
    routes: {},
    count: (intent) => requests.filter((r) => r.intent === intent).length,
    of: (intent) => requests.filter((r) => r.intent === intent),
    release() {
      for (const h of held) h();
      held.clear();
    },
  };
  const issue = () => {
    rotation += 1;
    const n = String(rotation + 1).padStart(4, '0');
    srv.tokens = { access: `ACCESS-token-${n}`, refresh: `REFRESH-token-${n}` };
    return {
      expiresIn: String(srv.expiresIn),
      openId: 'open-0001',
      accessToken: srv.tokens.access,
      refreshToken: srv.tokens.refresh,
    };
  };
  const tokenCheck = (r) => {
    if (r.headers.accesstoken === srv.tokens.access) return undefined;
    if (srv.expiredToken && r.headers.accesstoken === srv.expiredToken)
      return aqara(108, 'Token has expired');
    return aqara(2004, 'AccessToken incorrect');
  };
  const defaults = {
    'config.auth.getAuthCode': (r) =>
      r.data?.account === ACCOUNT ? { authCode: '' } : aqara(801, 'Account not register'),
    'config.auth.getToken': (r) =>
      r.data?.authCode === CODE && r.data?.account === ACCOUNT
        ? issue()
        : aqara(2003, 'AuthCode incorrect'),
    'config.auth.refreshToken': (r) =>
      r.data?.refreshToken === srv.tokens.refresh ? issue() : aqara(2006, 'RefreshToken incorrect'),
    'query.device.info': (r) => {
      const size = r.data?.pageSize ?? 50;
      const page = r.data?.pageNum ?? 1;
      return {
        data: data.devices.slice((page - 1) * size, page * size),
        totalCount: data.devices.length,
      };
    },
    'spec.query.qlinkmodel.config': (r) => {
      const out = {};
      for (const model of r.data?.models ?? [])
        if (data.models[model]) out[model] = data.models[model];
      return { data: out };
    },
    'spec.query.specdevice.config': () => ({ data: [] }),
    'spec.query.trait': (r) => ({
      data: (r.data?.traits ?? [])
        .map((t) => {
          const entry = data.values[`${t.deviceId}|${t.endpointId}|${t.traitCode}`];
          return entry ? { ...t, value: entry.value, time: entry.time } : undefined;
        })
        .filter(Boolean),
    }),
    'spec.write.trait': (r) => ({
      data: (r.data?.traits ?? []).map((t) => {
        if (srv.applyWrites) {
          const back = READ_BACK[t.traitCode];
          if (back)
            data.values[`${t.deviceId}|${t.endpointId}|${back}`] = { value: t.value, time: now() };
        }
        return { ...t, code: 0 };
      }),
    }),
  };
  srv.defaults = defaults;
  const NO_TOKEN = new Set([
    'config.auth.getAuthCode',
    'config.auth.getToken',
    'config.auth.refreshToken',
  ]);
  const answerOf = (record) => {
    const { intent } = record;
    if (srv.routes[intent]) return srv.routes[intent](record, srv);
    if (!defaults[intent]) return aqara(306, 'Request path not open');
    if (!NO_TOKEN.has(intent)) {
      const bad = tokenCheck(record);
      if (bad) return bad;
    }
    const result = defaults[intent](record, srv);
    return result?.__reply ? result : { __ok: true, result };
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        json = {};
      }
      const h = req.headers;
      const record = {
        method: req.method,
        path: req.url,
        headers: h,
        body,
        intent: json.intent,
        data: json.data,
      };
      requests.push(record);
      let answer;
      const text = `${h.accesstoken ? `Accesstoken=${h.accesstoken}&` : ''}Appid=${h.appid}&Keyid=${h.keyid}&Nonce=${h.nonce}&Time=${h.time}${KEYS.app_key}`;
      const expected = createHash('md5').update(text.toLowerCase()).digest('hex');
      if (req.method !== 'POST' || req.url !== '/v3.0/open/api') answer = reply(404, 'not found');
      else if (h.appid !== KEYS.app_id || h.keyid !== KEYS.key_id || h.sign !== expected)
        answer = aqara(106, 'Invalid sign');
      else answer = answerOf(record);
      if (answer === 'hang') {
        let release;
        const wait = new Promise((resolve) => (release = resolve));
        held.add(release);
        res.on('close', () => {
          held.delete(release);
          release();
        });
        await wait;
        held.delete(release);
        if (!res.writable || res.destroyed) return;
        const saved = srv.routes[record.intent];
        delete srv.routes[record.intent];
        answer = answerOf(record);
        if (saved) srv.routes[record.intent] = saved;
      }
      if (answer && typeof answer.then === 'function') {
        waiting += 1;
        try {
          answer = await answer;
        } finally {
          waiting -= 1;
        }
      }
      if (answer === 'drop') {
        req.socket.destroy();
        return;
      }
      if (srv.latencyMs) await new Promise((resolve) => setTimeout(resolve, srv.latencyMs));
      let status = 200;
      let out;
      let headers = {};
      if (answer?.__reply) ({ status, body: out, headers } = answer);
      else if (answer?.__ok)
        out = { code: 0, message: 'Success', requestId: 'x', result: answer.result };
      else out = { code: 0, message: 'Success', requestId: 'x', result: answer };
      const textOut = typeof out === 'string' ? out : JSON.stringify(out);
      if (!res.writable) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        Date: new Date(now()).toUTCString(),
        ...headers,
      });
      res.end(textOut);
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  srv.port = port;
  srv.url = `http://127.0.0.1:${port}/v3.0/open/api`;
  srv.close = async () => {
    srv.release();
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return srv;
}
