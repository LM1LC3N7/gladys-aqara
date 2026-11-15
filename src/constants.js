// -----------------------------------------------------------------------------
// Constants: manifest keys (frozen, users store them), Aqara Open API values,
// limits and timings. Every duration is in milliseconds.
// -----------------------------------------------------------------------------

/** Manifest action keys (frozen). */
export const ACTIONS = {
  SEND_CODE: 'send_code',
  AUTHORIZE: 'authorize',
  TEST: 'test_connection',
};

/**
 * The servers of the Aqara Open API (opendoc.aqara.com, "API Usage Guide",
 * domain list): config `region` (frozen) -> host.
 */
export const REGIONS = {
  ger: 'open-ger.aqara.com',
  usa: 'open-usa.aqara.com',
  cn: 'open-cn.aqara.com',
  kr: 'open-kr.aqara.com',
  ru: 'open-ru.aqara.com',
  sg: 'open-sg.aqara.com',
};

export const API_PATH = '/v3.0/open/api';

/** Intents of the Open API used here (nothing else is ever sent). */
export const INTENT = {
  GET_AUTH_CODE: 'config.auth.getAuthCode',
  GET_TOKEN: 'config.auth.getToken',
  REFRESH_TOKEN: 'config.auth.refreshToken',
  DEVICES: 'query.device.info',
  MODELS: 'spec.query.qlinkmodel.config',
  MATTER: 'spec.query.specdevice.config',
  TRAITS: 'spec.query.trait',
  WRITE: 'spec.write.trait',
};

/** Validity asked for the access token (the refresh token lives 30 days longer). */
export const TOKEN_VALIDITY = '7d';

/**
 * Return codes of the API (opendoc.aqara.com, "Error Code"), by meaning.
 * Anything else is a plain refusal of that request.
 */
export const CODES = {
  OK: 0,
  /** The project keys (Appid, Keyid, Appkey) are refused. */
  KEYS: new Set([106, 107, 2002]),
  /** The access token expired: renewed with the refresh token, then the request once again. */
  EXPIRED: new Set([108, 2005]),
  /** The access token is absent or wrong: renewed once; a refused renewal ends the authorization. */
  TOKEN: new Set([109, 804, 2004, 2009]),
  /** The refresh token is refused: the user authorizes again. */
  REFRESH: new Set([2006, 2007]),
  /** Too many requests (also HTTP 429). */
  RATE: new Set([429]),
  /** The server is busy or failing (also HTTP 5xx). */
  SERVER: new Set([100, 104, 500, 501]),
  /** The request date is refused (the clock of the host is wrong). */
  CLOCK: new Set([105]),
  /** The verification code is wrong or expired (authorization). */
  AUTH_CODE: new Set([811, 816, 820, 2003]),
  /** Verification codes asked too often. */
  CODE_TOO_OFTEN: new Set([817]),
  /** The Aqara account is unknown or malformed. */
  ACCOUNT: new Set([801, 807, 812]),
  /** One device (offline, not supported, permission): never about the account. */
  DEVICE: new Set([601, 602, 603, 604, 606, 612, 638, 664, 717, 747, 1003, 1004, 1007, 1008]),
  /** A permission refused on one route: never a refusal of the credentials. */
  PERMISSION: new Set([403, 706, 755, 756, 803, 2008, 2010, 2012, 2013, 2014, 2022]),
};

/**
 * Device types (opendoc.aqara.com, "Supported Device Types") a device must
 * NOT have to be commanded by this module (v1: locks, cameras, garage doors,
 * valves, pumps, window openers and heating stay read only, nothing written).
 */
export const NEVER_COMMANDED = new Set([
  'AccessController',
  'AirConditioner',
  'AirConditionerController',
  'BathroomHeater',
  'Camera',
  'CookSurface',
  'Cooktop',
  'ElectricCooker',
  'DoorLock',
  'ElectricVehicleSupplyEquipment',
  'FloorHeating',
  'GarageDoor',
  'GeneralValve',
  'Hearth',
  'HeatPump',
  'MicrowaveOven',
  'Oven',
  'Pump',
  'Pusher',
  'Thermostat',
  'ThermostatController',
  'TowelRack',
  'Valve',
  'VideoDoorbell',
  'WaterHeater',
]);

/** Endpoint types whose OnOff trait is a Gladys light or switch. */
export const ONOFF_LIGHT = new Set(['Light']);
export const ONOFF_SWITCH = new Set(['Outlet', 'Switch']);

export const LIMITS = {
  /** Bytes of one API answer read at most (a larger one is cut and refused). */
  answerBytes: 1024 * 1024,
  /** Devices kept from the list (pages of 50). */
  devices: 300,
  pageSize: 50,
  /** Models per spec.query.qlinkmodel.config, devices per spec.query.specdevice.config. */
  modelsPerCall: 5,
  matterPerCall: 10,
  /** Traits per spec.query.trait. */
  traitsPerCall: 50,
  /** Of one model configuration: endpoints, functions per endpoint, traits per function. */
  endpoints: 64,
  functions: 64,
  traits: 128,
  /** Features of one Gladys device. */
  features: 40,
  /** Characters of a name kept. */
  name: 60,
  /** Gladys: states per minute. */
  statesPerMinute: 300,
  /** Source dates kept in /data (dedup of measurements). */
  seen: 500,
  /** Stops kept in /data. */
  stops: 100,
  /** Characters of a status or action message. */
  message: 900,
};

export const TIMINGS = {
  /** Poll interval: default and bounds. */
  pollDefault: 120_000,
  pollMin: 60_000,
  pollMax: 3_600_000,
  /** The device list is read again at most this often (Scan and the test button read it too). */
  listEvery: 10 * 60_000,
  /** Device list older than this: commands that start something are refused. */
  listMaxAge: 15 * 60_000,
  /** One API request bounded in time. */
  readTimeout: 10_000,
  /** A command: the answer awaited at most this long before the ack (Gladys cuts at 5 s). */
  commandAck: 3_000,
  /** A command request itself, bounded (its answer may come after the ack). */
  commandTimeout: 8_000,
  /** A stop retried within this budget when nothing could be sent. */
  stopRetry: 250,
  /** Reads of a commanded value after the send, from the send (confirmation). */
  followUps: [5_000, 20_000],
  /** A stop that could not be sent: tried again on this spacing, up to stopAttempts. */
  stopAttempts: 6,
  stopRetrySpacing: 10_000,
  /** A stop contradicted by the reads that follow it is sent again at most this many times. */
  stopResends: 2,
  /** A stop kept in /data is dropped past this age (never replayed late). */
  stopMaxAge: 120_000,
  /** 429 / 5xx: pause, doubled at each one in a row. */
  pauseMin: 60_000,
  pauseMax: 6 * 3_600_000,
  /** Secondary route refused (models, values): spacing, doubled up to this. */
  secondaryMax: 3_600_000,
  /** getConfig failed: spacing of the next tries. */
  configRetry: [5_000, 15_000, 60_000, 300_000],
  /** /data unreadable: read again on this timer. */
  storeRetry: 10_000,
  /** /data load or save bounded. */
  storeTimeout: 2_000,
  storeQueue: 2_000,
  /** States: flush spacing, freshness of a value waiting, measurement spacing. */
  flush: 1_000,
  stateFresh: 120_000,
  measurementSpacing: 5_000,
  stateHeartbeat: 3_600_000,
  /** A measurement older than this is not published. */
  valueMaxAge: 2 * 3_600_000,
  /** A source date this far in the future is invalid. */
  futureSkew: 300_000,
  /** The access token is renewed when it expires within this. */
  tokenRenewBefore: 24 * 3_600_000,
  /** The verification code: one request per click, never two within this. */
  codeSpacing: 60_000,
  /** A verification code is valid 10 minutes (opendoc.aqara.com). */
  codeValidity: 10 * 60_000,
  /** Test button: never reads sooner than this after the last read. */
  testSpacing: 60_000,
};

/** Default daily budget of API calls (config `daily_calls`) and its bounds. */
export const BUDGET = { default: 3000, min: 200, max: 100_000 };

/** Gladys core values (server/utils/constants.js). */
export const STATE = { OFF: 0, ON: 1 };
/** Gladys opening sensor: 0 open, 1 closed (OPENING_SENSOR_STATE). */
export const OPENING = { OPEN: 0, CLOSED: 1 };
