// -----------------------------------------------------------------------------
// Aqara answers -> Gladys devices, values and commands (pure).
//
// Identifier rule (frozen, it fixes the external ids):
//   `ext:<selector>:device:<prefix>-<rest>`   one Aqara device, its `did`
//   `<prefix>.<rest>` (e.g. `lumi.158d000488d874`) with its first dot as a
//   dash (the prefix holds letters and digits only, so the rule is
//   reversible); feature `...:e<endpoint>-<key>` (key below).
//
// The devices are described by the "trait" model of the Open API
// (opendoc.aqara.com, "Device Resource Management (Trait)"): endpoints,
// functions, traits with a standard trait code (OnOff, CurrentHumidity...).
// Only the trait codes of the table below are used; anything else is left
// out. A value outside its range, of the wrong type or in an unexpected unit
// is unknown (never published, never 0).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { LIMITS, NEVER_COMMANDED, ONOFF_LIGHT, ONOFF_SWITCH, OPENING, STATE } from './constants.js';
import { featureLabel } from './i18n.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** A name from the API: printable, trimmed, bounded. */
export function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
}

const DID_RE = /^([A-Za-z0-9]{1,24})\.([A-Za-z0-9_-]{1,64})$/;
const PLATFORM_RE = /^([A-Za-z0-9]{1,24})-([A-Za-z0-9_-]{1,64})$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** A device id of the API, else undefined. */
export const didOf = (value) =>
  typeof value === 'string' && DID_RE.test(value) ? value : undefined;
/** did -> the platform id of the external ids (first dot as a dash). */
export const platformOf = (did) => did.replace('.', '-');
/** platform id -> did, else undefined. */
export function didOfPlatform(platform) {
  const match = typeof platform === 'string' ? PLATFORM_RE.exec(platform) : null;
  return match ? `${match[1]}.${match[2]}` : undefined;
}
export const modelOf = (value) =>
  typeof value === 'string' && MODEL_RE.test(value) ? value : undefined;
/** Matter devices are described by device (spec.query.specdevice.config), the others by model. */
export const isMatter = (model) => model.startsWith('aqara.matter');

/** A strict integer of a JSON value (number or decimal text), else undefined. */
export function intOf(value, min, max) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^-?\d{1,15}$/.test(value)) n = Number(value);
  else return undefined;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

/** A strict decimal of a JSON value, else undefined (`''`, null, `'abc'` are unknown, never 0). */
export function decimalOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d{1,9}(?:\.\d{1,6})?$/.test(value)) return Number(value);
  return undefined;
}

/** A strict boolean of a JSON value (true/false, 'true'/'false', 1/0, '1'/'0'), else undefined. */
export function boolOf(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

/** The device list of query.device.info: `{ devices, total }` or undefined (not a list). */
export function parseDevicePage(result) {
  const data = own(result, 'data');
  if (!Array.isArray(data)) return undefined;
  const total = intOf(own(result, 'totalCount'), 0, 1e6);
  const devices = [];
  for (const entry of data.slice(0, LIMITS.pageSize * 2)) {
    const did = didOf(own(entry, 'did'));
    const model = modelOf(own(entry, 'model'));
    if (!did || !model) continue;
    const state = intOf(own(entry, 'state'), 0, 1);
    devices.push({
      did,
      model,
      name: cleanName(own(entry, 'deviceName')) || model,
      online: state === undefined ? undefined : state === 1,
      parent: didOf(own(entry, 'parentDid')),
    });
  }
  return { devices, total, count: data.length };
}

// --- Trait model --------------------------------------------------------------

const UNITS = {
  celsius: ['°C', '℃', 'C', 'celsius', '°c'],
  percent: ['%', 'percent'],
  kpa: ['kPa', 'kpa', 'KPa'],
  lux: ['lux', 'lx'],
  ppm: ['ppm'],
  ppb: ['ppb'],
  ugm3: ['ug/m³', 'µg/m³', 'μg/m³', 'ug/m3', 'µg/m3'],
  watt: ['W', 'w', 'watt'],
  volt: ['V', 'v', 'volt'],
  ampere: ['A', 'a', 'ampere'],
};

/**
 * The trait codes used (frozen keys). `measure`: a measurement (spaced, its
 * source date must be fresh); otherwise a state (published as the current
 * one). `units`: the unit the API must declare, when it declares one.
 */
export const MEASURES = {
  CurrentTemperature: {
    key: 'temperature',
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    units: UNITS.celsius,
    min: -50,
    max: 100,
  },
  CurrentHumidity: {
    key: 'humidity',
    category: C.HUMIDITY_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.PERCENT,
    units: UNITS.percent,
    min: 0,
    max: 100,
  },
  CurrentPressure: {
    key: 'pressure',
    category: C.PRESSURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.KILO_PASCAL,
    units: UNITS.kpa,
    min: 30,
    max: 120,
  },
  CurrentIlluminance: {
    key: 'illuminance',
    category: C.LIGHT_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.LUX,
    units: UNITS.lux,
    min: 0,
    max: 200_000,
  },
  CO2Density: {
    key: 'co2',
    category: C.CO2_SENSOR,
    type: T.SENSOR.INTEGER,
    unit: U.PPM,
    units: UNITS.ppm,
    min: 0,
    max: 10_000,
    integer: true,
  },
  'PM2.5Density': {
    key: 'pm25',
    category: C.PM25_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.MICROGRAM_PER_CUBIC_METER,
    units: UNITS.ugm3,
    min: 0,
    max: 2_000,
  },
  VOCDensity: {
    key: 'voc',
    category: C.VOC_SENSOR,
    type: T.VOC_SENSOR.DECIMAL,
    unit: U.PPB,
    units: UNITS.ppb,
    min: 0,
    max: 100_000,
  },
  BatPercentRemaining: {
    key: 'battery',
    category: C.BATTERY,
    type: T.BATTERY.INTEGER,
    unit: U.PERCENT,
    units: UNITS.percent,
    min: 0,
    max: 100,
    integer: true,
  },
  CurrentPower: {
    key: 'power',
    category: C.SWITCH,
    type: T.SWITCH.POWER,
    unit: U.WATT,
    units: UNITS.watt,
    min: 0,
    max: 10_000,
  },
  CurrentVoltage: {
    key: 'voltage',
    category: C.SWITCH,
    type: T.SWITCH.VOLTAGE,
    unit: U.VOLT,
    units: UNITS.volt,
    min: 0,
    max: 500,
  },
  CircuitCurrent: {
    key: 'current',
    category: C.SWITCH,
    type: T.SWITCH.CURRENT,
    unit: U.AMPERE,
    units: UNITS.ampere,
    min: 0,
    max: 100,
  },
};

/** Boolean sensors (states). `open`: how the API value maps (see contactMeaning). */
export const BINARIES = {
  ContactSensorState: { key: 'contact', category: C.OPENING_SENSOR, type: T.SENSOR.BINARY },
  LeakState: { key: 'leak', category: C.LEAK_SENSOR, type: T.SENSOR.BINARY },
  Occupancy: { key: 'occupancy', category: C.PRESENCE_SENSOR, type: T.SENSOR.BINARY },
  SmokeDetected: { key: 'smoke', category: C.SMOKE_SENSOR, type: T.SENSOR.BINARY },
  CODetected: { key: 'co', category: C.CO_SENSOR, type: T.SENSOR.BINARY },
};

/** Feature keys of the commanded features (frozen). */
export const KEYS = { ONOFF: 'onoff', BRIGHTNESS: 'brightness', POSITION: 'position' };

/** The parameter of a trait (`parameter` or `attribute`, both spellings of the API). */
function parameterOf(trait) {
  const p = own(trait, 'parameter') ?? own(trait, 'attribute');
  const enums = list(own(p, 'supportedValues') ?? own(p, 'enums'), 32)
    .map((e) => ({ key: own(e, 'key'), value: own(e, 'value') }))
    .filter((e) => typeof e.key === 'string');
  const unit = own(p, 'unit');
  return {
    readable: own(p, 'readable') !== false,
    writable: own(p, 'writable') === true,
    unit: typeof unit === 'string' && unit.trim() ? unit.trim() : undefined,
    min: decimalOf(own(p, 'min') ?? own(p, 'minValue')),
    max: decimalOf(own(p, 'max') ?? own(p, 'maxValue')),
    enums,
  };
}

const CODE_RE = /^[A-Za-z0-9.]{1,64}$/;
const TYPE_RE = /^[A-Za-z0-9]{1,64}$/;
const types = (value) =>
  (Array.isArray(value) ? value : typeof value === 'string' ? [value] : [])
    .slice(0, 16)
    .filter((t) => typeof t === 'string' && TYPE_RE.test(t));

/**
 * One device description of the trait model (an entry of
 * spec.query.qlinkmodel.config or spec.query.specdevice.config):
 * `{ types, endpoints: [{ id, types, traits: [{ functionCode, traitCode, ...parameter }] }] }`
 * or undefined. Bounded, linear, unknown keys ignored.
 */
export function parseDescription(entry) {
  if (!isObject(entry)) return undefined;
  const raw = own(entry, 'endpoints');
  if (!Array.isArray(raw)) return undefined;
  const endpoints = [];
  for (const e of raw.slice(0, LIMITS.endpoints)) {
    const id = intOf(own(e, 'endpointId'), 0, 9999);
    if (id === undefined) continue;
    const traits = [];
    for (const f of list(own(e, 'functions'), LIMITS.functions)) {
      const functionCode = own(f, 'functionCode');
      if (typeof functionCode !== 'string' || !CODE_RE.test(functionCode)) continue;
      for (const t of list(own(f, 'traits'), LIMITS.traits)) {
        const traitCode = own(t, 'traitCode');
        if (typeof traitCode !== 'string' || !CODE_RE.test(traitCode)) continue;
        traits.push({ functionCode, traitCode, ...parameterOf(t) });
      }
    }
    endpoints.push({
      id,
      types: types(own(e, 'deviceType') ?? own(e, 'endpointTypes') ?? own(e, 'deviceTypes')),
      traits,
    });
  }
  return { types: types(own(entry, 'deviceTypesList') ?? own(entry, 'types')), endpoints };
}

/** The descriptions of spec.query.qlinkmodel.config: Map model -> description. */
export function parseModels(result) {
  const data = own(result, 'data');
  const out = new Map();
  if (!isObject(data)) return out;
  for (const model of Object.keys(data).slice(0, 32)) {
    if (!modelOf(model)) continue;
    const description = parseDescription(data[model]);
    if (description) out.set(model, description);
  }
  return out;
}

/** The descriptions of spec.query.specdevice.config: Map did -> description. */
export function parseMatter(result) {
  const out = new Map();
  for (const entry of list(own(result, 'data'), 32)) {
    const did = didOf(own(entry, 'deviceId'));
    const description = parseDescription(entry);
    if (did && description) out.set(did, description);
  }
  return out;
}

const unitOk = (declared, accepted) => declared === undefined || accepted.includes(declared);

/**
 * The open/closed meaning of a contact trait: `true` when the API value
 * `true` means open. From the enum labels when the model gives them
 * (Open/Close...), else open (the trait is "contact sensor state", 1 = open,
 * an assumption noted in the documentation).
 */
export function contactMeaning(enums) {
  let open;
  let closed;
  for (const { key, value } of enums) {
    const b = boolOf(value);
    if (b === undefined) continue;
    if (/^(?:open|opened|no ?contact|not ?detected)$/i.test(key.trim())) open = b;
    else if (/^(?:close|closed|contact|detected)$/i.test(key.trim())) closed = b;
  }
  if (open !== undefined && closed !== undefined && open !== closed) return open;
  if (open !== undefined && closed === undefined) return open;
  if (closed !== undefined && open === undefined) return !closed;
  return true;
}

const findTrait = (endpoint, code) => endpoint.traits.find((t) => t.traitCode === code);

/**
 * The features of one device from its description: `[{ key, endpoint,
 * functionCode, traitCode, kind, def, writable, ...}]`, bounded. `kind`:
 * 'onoff' | 'brightness' | 'position' | 'measure' | 'binary'.
 */
export function featuresOf(description) {
  if (!description) return [];
  const all = new Set([...description.types, ...description.endpoints.flatMap((e) => e.types)]);
  const commandable = ![...all].some((t) => NEVER_COMMANDED.has(t));
  const out = [];
  for (const endpoint of description.endpoints) {
    const at = (key) => `e${endpoint.id}-${key}`;
    const isLight = endpoint.types.some((t) => ONOFF_LIGHT.has(t));
    const isSwitch = endpoint.types.some((t) => ONOFF_SWITCH.has(t));
    const onoff = findTrait(endpoint, 'OnOff');
    if (onoff && onoff.readable && (isLight || isSwitch)) {
      out.push({
        key: at(KEYS.ONOFF),
        label: KEYS.ONOFF,
        endpoint: endpoint.id,
        functionCode: onoff.functionCode,
        traitCode: 'OnOff',
        kind: 'onoff',
        light: isLight,
        writable: commandable && onoff.writable,
      });
      const level = findTrait(endpoint, 'CurrentLevel');
      if (
        isLight &&
        level?.readable &&
        unitOk(level.unit, UNITS.percent) &&
        (level.max === undefined || level.max <= 100)
      ) {
        out.push({
          key: at(KEYS.BRIGHTNESS),
          label: KEYS.BRIGHTNESS,
          endpoint: endpoint.id,
          functionCode: level.functionCode,
          traitCode: 'CurrentLevel',
          kind: 'brightness',
          writable: commandable && level.writable,
        });
      }
    }
    const current = findTrait(endpoint, 'CurrentPositionPercentage');
    if (current?.readable && unitOk(current.unit, UNITS.percent)) {
      const target = findTrait(endpoint, 'TargetPositionPercentage');
      out.push({
        key: at(KEYS.POSITION),
        label: KEYS.POSITION,
        endpoint: endpoint.id,
        functionCode: current.functionCode,
        traitCode: 'CurrentPositionPercentage',
        kind: 'position',
        // Read only in v1: the documentation gives no direction for the positions (HomeKit
        // and Matter are opposite), so nothing is ever written until a tester confirms it.
        writable: false,
        write: target
          ? { functionCode: target.functionCode, traitCode: 'TargetPositionPercentage' }
          : undefined,
      });
    }
    for (const trait of endpoint.traits) {
      const measure = Object.hasOwn(MEASURES, trait.traitCode)
        ? MEASURES[trait.traitCode]
        : undefined;
      if (measure && trait.readable && unitOk(trait.unit, measure.units)) {
        out.push({
          key: at(measure.key),
          label: measure.key,
          endpoint: endpoint.id,
          functionCode: trait.functionCode,
          traitCode: trait.traitCode,
          kind: 'measure',
          def: measure,
          writable: false,
        });
      }
      const binary = Object.hasOwn(BINARIES, trait.traitCode)
        ? BINARIES[trait.traitCode]
        : undefined;
      if (binary && trait.readable) {
        out.push({
          key: at(binary.key),
          label: binary.key,
          endpoint: endpoint.id,
          functionCode: trait.functionCode,
          traitCode: trait.traitCode,
          kind: 'binary',
          def: binary,
          openWhenTrue: binary.key === 'contact' ? contactMeaning(trait.enums) : undefined,
          writable: false,
        });
      }
    }
  }
  // One feature per key (a description listing a trait twice), bounded.
  const seen = new Set();
  return out.filter((f) => !seen.has(f.key) && seen.add(f.key)).slice(0, LIMITS.features);
}

/** The Reachable trait of a description (online state read with the values), if any. */
export function reachableOf(description) {
  for (const endpoint of description?.endpoints ?? []) {
    const t = findTrait(endpoint, 'Reachable');
    if (t?.readable)
      return { endpoint: endpoint.id, functionCode: t.functionCode, traitCode: 'Reachable' };
  }
  return undefined;
}

/** The Gladys value of a trait value read for a feature, else undefined (unknown). */
export function valueOf(feature, raw) {
  switch (feature.kind) {
    case 'onoff': {
      const b = boolOf(raw);
      return b === undefined ? undefined : b ? STATE.ON : STATE.OFF;
    }
    case 'brightness':
    case 'position': {
      const n = decimalOf(raw);
      return n === undefined || n < 0 || n > 100 ? undefined : Math.round(n);
    }
    case 'binary': {
      const b = boolOf(raw);
      if (b === undefined) return undefined;
      if (feature.label === 'contact') {
        return b === feature.openWhenTrue ? OPENING.OPEN : OPENING.CLOSED;
      }
      return b ? 1 : 0;
    }
    case 'measure': {
      const def = feature.def;
      const n = def.integer ? intOf(raw, def.min, def.max) : decimalOf(raw);
      if (n === undefined || n < def.min || n > def.max) return undefined;
      return def.integer ? n : Math.round(n * 100) / 100;
    }
    default:
      return undefined;
  }
}

/** The Gladys feature declaration of a feature. */
function declaration(feature) {
  switch (feature.kind) {
    case 'onoff':
      return {
        category: feature.light ? C.LIGHT : C.SWITCH,
        type: feature.light ? T.LIGHT.BINARY : T.SWITCH.BINARY,
        min: 0,
        max: 1,
        read_only: !feature.writable,
        has_feedback: true,
        keep_history: true,
      };
    case 'brightness':
      return {
        category: C.LIGHT,
        type: T.LIGHT.BRIGHTNESS,
        min: 0,
        max: 100,
        read_only: !feature.writable,
        has_feedback: true,
        keep_history: false,
      };
    case 'position':
      return {
        category: C.CURTAIN,
        type: T.CURTAIN.POSITION,
        unit: U.PERCENT,
        min: 0,
        max: 100,
        read_only: !feature.writable,
        has_feedback: true,
        keep_history: true,
      };
    case 'binary':
      return {
        category: feature.def.category,
        type: feature.def.type,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      };
    default:
      return {
        category: feature.def.category,
        type: feature.def.type,
        unit: feature.def.unit,
        min: feature.def.min,
        max: feature.def.max,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      };
  }
}

/** The trait a feature is written to. */
export const writeOf = (feature) =>
  feature.kind === 'position'
    ? feature.write
    : { functionCode: feature.functionCode, traitCode: feature.traitCode };

/** Prefix of the device params telling where a feature is written. */
export const WRITE_PARAM = 'aqara_write_';

/**
 * The commanded feature of a key from the params of a created device (a stop
 * sent before any read: no description in memory yet), else undefined.
 */
export function featureFromParams(device, key) {
  const match = /^e((?:0|[1-9]\d{0,3}))-(onoff|brightness)$/.exec(key);
  if (!match) return undefined;
  const params = Array.isArray(device?.params) ? device.params : [];
  const read = (k) => {
    const p = params.find((x) => x?.name === `${WRITE_PARAM}${k}`);
    const m =
      typeof p?.value === 'string'
        ? /^([A-Za-z0-9.]{1,64})\/([A-Za-z0-9.]{1,64})$/.exec(p.value)
        : null;
    return m ? { functionCode: m[1], traitCode: m[2] } : undefined;
  };
  const endpoint = Number(match[1]);
  const kind = match[2];
  const w = read(key);
  if (!w) return undefined;
  if (kind === 'onoff' && w.traitCode === 'OnOff')
    return {
      key,
      label: kind,
      endpoint,
      kind,
      functionCode: w.functionCode,
      traitCode: 'OnOff',
      writable: true,
    };
  if (kind === 'brightness' && w.traitCode === 'CurrentLevel')
    return {
      key,
      label: kind,
      endpoint,
      kind,
      functionCode: w.functionCode,
      traitCode: 'CurrentLevel',
      writable: true,
    };
  return undefined;
}

export const deviceIds = (gladys, did) => gladys.externalIds('device', platformOf(did));

/** The Gladys device of an Aqara device and its features (none: undefined, never listed). */
export function buildDevice(gladys, device, features, { language = 'en' } = {}) {
  if (features.length === 0) return undefined;
  const ids = deviceIds(gladys, device.did);
  return {
    name: device.name,
    external_id: ids.device,
    model: device.model,
    should_poll: false,
    features: features.map((f) => ({
      name: `${device.name} - ${featureLabel(f.label, f.endpoint, language)}`.slice(0, 100),
      external_id: ids.feature(f.key),
      ...declaration(f),
    })),
    params: [
      { name: 'aqara_did', value: device.did },
      { name: 'aqara_model', value: device.model },
      // Where each commanded value is written: a stop (turn off, close) sent
      // right after a restart, before the first read, still knows it.
      ...features
        .filter((f) => f.writable)
        .map((f) => {
          const w = writeOf(f);
          return { name: `${WRITE_PARAM}${f.key}`, value: `${w.functionCode}/${w.traitCode}` };
        }),
    ],
  };
}

/**
 * A feature external id -> `{ did, key }`, else undefined. Only the exact
 * form this module builds (prefix of the selector, platform id, feature key).
 */
export function parseExternalId(externalId, prefix) {
  if (typeof externalId !== 'string' || !externalId.startsWith(`${prefix}device:`))
    return undefined;
  const rest = externalId.slice(`${prefix}device:`.length);
  const match =
    /^([A-Za-z0-9]{1,24}-[A-Za-z0-9_-]{1,64}):(e(?:0|[1-9]\d{0,3})-[a-z0-9]{1,16})$/.exec(rest);
  if (!match) return undefined;
  const did = didOfPlatform(match[1]);
  return did ? { did, key: match[2] } : undefined;
}

/**
 * The command of a Gladys value for a feature: `{ protective, value, trait }`
 * (`value` as the API takes it), else undefined (invalid). Turning off is
 * protective; a brightness 0 is a turn off. A position command is built but
 * never sent: positions are read only in v1 (not `writable`).
 */
export function commandOf(feature, value, features = []) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (feature.kind === 'onoff') {
    if (value !== 0 && value !== 1) return undefined;
    return {
      protective: value === 0,
      feature,
      write: { functionCode: feature.functionCode, traitCode: 'OnOff' },
      value: value === 1,
      expect: value,
    };
  }
  if (feature.kind === 'brightness') {
    if (!Number.isInteger(value) || value < 0 || value > 100) return undefined;
    if (value === 0) {
      const onoff = features.find((f) => f.kind === 'onoff' && f.endpoint === feature.endpoint);
      return onoff ? commandOf(onoff, 0) : undefined;
    }
    return {
      protective: false,
      feature,
      write: { functionCode: feature.functionCode, traitCode: 'CurrentLevel' },
      value,
      expect: value,
    };
  }
  if (feature.kind === 'position') {
    if (!Number.isInteger(value) || value < 0 || value > 100 || !feature.write) return undefined;
    return { protective: value === 0, feature, write: feature.write, value, expect: value };
  }
  return undefined;
}
