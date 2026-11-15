// -----------------------------------------------------------------------------
// The configuration of the Configuration screen, normalized. Never throws:
// an invalid value is reported (`errors`, config keys only, never the value
// itself). Secrets are kept as given, never logged, never in an error.
// -----------------------------------------------------------------------------

import { BUDGET, REGIONS, TIMINGS } from './constants.js';

/** The defaults the manifest declares too (tied by test/manifest.test.js). */
export const DEFAULT_CONFIG = { region: 'ger', poll_seconds: 120, daily_calls: BUDGET.default };

// Printable ASCII, no space, no control byte (CR/LF never reach a header).
const APP_ID_RE = /^[A-Za-z0-9._-]{4,128}$/;
const KEY_ID_RE = /^[\x21-\x7e]{1,128}$/;
const APP_KEY_RE = /^[\x21-\x7e]{8,256}$/;
const TOKEN_RE = /^[\x21-\x7e]{8,512}$/;
// An e-mail address or a phone number, printable, no space inside.
const ACCOUNT_RE =
  // eslint-disable-next-line no-control-regex
  /^(?:[^\s@\x00-\x1f\x7f]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}|\+?[0-9]{6,20})$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function field(raw, re) {
  const value = text(raw);
  if (!value) return { missing: true };
  return re.test(value) ? { value } : { invalid: true };
}

const int = (value, fallback, min, max) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? Math.min(Math.max(n, min), max) : fallback;
};

/**
 * `{ region, keys?, account?, tokens?, pollMs, dailyCalls, errors, tokenErrors }`:
 * `keys` when the three project keys are valid, `tokens` when both tokens
 * are; `errors` (project keys, region) and `tokenErrors` hold config keys only.
 */
export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const tokenErrors = [];
  const region = Object.hasOwn(REGIONS, config.region) ? config.region : DEFAULT_CONFIG.region;
  if (
    config.region !== undefined &&
    config.region !== null &&
    config.region !== '' &&
    region !== config.region
  )
    errors.push('region');
  const appId = field(config.app_id, APP_ID_RE);
  const keyId = field(config.key_id, KEY_ID_RE);
  const appKey = field(config.app_key, APP_KEY_RE);
  for (const [key, f] of [
    ['app_id', appId],
    ['key_id', keyId],
    ['app_key', appKey],
  ]) {
    if (!f.value) errors.push(key);
  }
  const keys =
    appId.value && keyId.value && appKey.value
      ? { appId: appId.value, keyId: keyId.value, appKey: appKey.value }
      : undefined;
  const account = field(config.account, ACCOUNT_RE);
  const access = field(config.access_token, TOKEN_RE);
  const refresh = field(config.refresh_token, TOKEN_RE);
  if (access.invalid) tokenErrors.push('access_token');
  if (refresh.invalid) tokenErrors.push('refresh_token');
  const tokens =
    access.value && refresh.value ? { access: access.value, refresh: refresh.value } : undefined;
  const seconds = int(config.poll_seconds, DEFAULT_CONFIG.poll_seconds, 1, 1e6);
  const pollMs = Math.min(Math.max(seconds * 1000, TIMINGS.pollMin), TIMINGS.pollMax);
  const dailyCalls = int(config.daily_calls, BUDGET.default, BUDGET.min, BUDGET.max);
  return {
    region,
    keys,
    account: account.value,
    accountInvalid: Boolean(account.invalid),
    tokens,
    pollMs,
    dailyCalls,
    errors,
    tokenErrors,
  };
}

/** The identity of the project keys (what a refusal of the keys is about), never stored as such. */
export const keysText = (config) =>
  ['keys', config.region, config.keys?.appId, config.keys?.keyId, config.keys?.appKey].join('\0');

/** The identity of the authorization (the refresh token decides), never stored as such. */
export const grantText = (config, tokens = config.tokens) =>
  ['grant', config.region, config.keys?.appId, tokens?.refresh].join('\0');
