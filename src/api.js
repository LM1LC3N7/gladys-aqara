// -----------------------------------------------------------------------------
// The Aqara Open API (opendoc.aqara.com): every request is a POST of
// `{ intent, data }` to `https://<regional server>/v3.0/open/api`, signed with
// the keys of the user's developer project:
//   Sign = md5(lowercase("Accesstoken=..&Appid=..&Keyid=..&Nonce=..&Time=.." + Appkey))
// (Accesstoken left out of the headers and of the signature when there is
// none: the authorization requests). The answer is `{ code, message, result }`;
// `code` 0 is a success.
//
// Every answer is classified (ApiError.kind): 'keys', 'expired', 'token',
// 'refresh', 'rate', 'server', 'clock', 'auth-code', 'code-too-often',
// 'account', 'device', 'permission', 'refused' (any other code), 'bad' (not
// the JSON envelope of the API, cut, a redirect, an HTTP error without the
// envelope), or the network kinds of src/http.js. The keys and the tokens
// never appear in an error, a log or a status.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { request } from './http.js';
import { API_PATH, CODES, REGIONS } from './constants.js';

export class ApiError extends Error {
  constructor(kind, { sent = true, status, code, retryAfter, detail } = {}) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = kind;
    this.sent = sent;
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** The Sign header (opendoc.aqara.com, "Sign Generation Rules"). */
export function sign({ accessToken, appId, keyId, nonce, time, appKey }) {
  let text = '';
  if (accessToken) text += `Accesstoken=${accessToken}&`;
  text += `Appid=${appId}&Keyid=${keyId}&Nonce=${nonce}&Time=${time}${appKey}`;
  return createHash('md5').update(text.toLowerCase(), 'utf8').digest('hex');
}

/** Milliseconds of a Retry-After header (a number of seconds or an HTTP date against the Date header). */
export function retryAfterMs(headers) {
  const value = headers?.['retry-after'];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d{1,7}$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  const now = Date.parse(headers.date ?? '');
  return Number.isFinite(at) && Number.isFinite(now) ? Math.max(0, at - now) : undefined;
}

/** The kind of a return code (see CODES). */
export function kindOfCode(code) {
  if (CODES.KEYS.has(code)) return 'keys';
  if (CODES.EXPIRED.has(code)) return 'expired';
  if (CODES.TOKEN.has(code)) return 'token';
  if (CODES.REFRESH.has(code)) return 'refresh';
  if (CODES.RATE.has(code)) return 'rate';
  if (CODES.SERVER.has(code)) return 'server';
  if (CODES.CLOCK.has(code)) return 'clock';
  if (CODES.AUTH_CODE.has(code)) return 'auth-code';
  if (CODES.CODE_TOO_OFTEN.has(code)) return 'code-too-often';
  if (CODES.ACCOUNT.has(code)) return 'account';
  if (CODES.DEVICE.has(code)) return 'device';
  if (CODES.PERMISSION.has(code)) return 'permission';
  return 'refused';
}

/**
 * One API client for one configuration (region and project keys). `call`
 * resolves `{ result, date }` (the `result` of the answer, the server date in
 * ms or undefined).
 */
export class AqaraApi {
  constructor(
    config,
    { baseUrl, now = Date.now, request: send = request, timers = globalThis } = {},
  ) {
    this.keys = config.keys;
    this.url = baseUrl ?? `https://${REGIONS[config.region]}${API_PATH}`;
    this.now = now;
    this.send = send;
    this.timers = timers;
  }

  headers(accessToken) {
    const nonce = randomBytes(12).toString('hex');
    const time = String(Math.floor(this.now()));
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'gladys-aqara (+https://github.com/LM1LC3N7/gladys-aqara)',
      Appid: this.keys.appId,
      Keyid: this.keys.keyId,
      Nonce: nonce,
      Time: time,
      Lang: 'en',
      Sign: sign({ accessToken, ...this.keys, nonce, time }),
    };
    if (accessToken) headers.Accesstoken = accessToken;
    return headers;
  }

  /**
   * `options`: `accessToken` (none for the authorization intents),
   * `timeoutMs`, `signal`, `onSent` (called once the request left).
   */
  async call(intent, data, { accessToken, timeoutMs, signal, onSent } = {}) {
    const body = JSON.stringify({ intent, data });
    let res;
    try {
      res = await this.send(this.url, {
        method: 'POST',
        headers: this.headers(accessToken),
        body,
        timeoutMs,
        signal,
        onSent,
        timers: this.timers,
      });
    } catch (err) {
      throw new ApiError(err.kind ?? 'network', { sent: err.sent === true, detail: err.message });
    }
    const date = Date.parse(res.headers?.date ?? '');
    const status = res.status;
    if (status === 429)
      throw new ApiError('rate', { status, retryAfter: retryAfterMs(res.headers) });
    if (status >= 500)
      throw new ApiError('server', { status, retryAfter: retryAfterMs(res.headers) });
    if (status < 200 || status > 299)
      throw new ApiError('bad', { status, detail: `HTTP ${status}` });
    let json;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new ApiError('bad', { status, detail: 'not JSON' });
    }
    if (!json || typeof json !== 'object' || Array.isArray(json) || !Object.hasOwn(json, 'code')) {
      throw new ApiError('bad', { status, detail: 'not the Aqara envelope' });
    }
    const code = json.code;
    if (!Number.isInteger(code)) throw new ApiError('bad', { status, detail: 'no return code' });
    if (code !== 0) {
      const kind = kindOfCode(code);
      throw new ApiError(kind, {
        status,
        code,
        retryAfter: kind === 'rate' || kind === 'server' ? retryAfterMs(res.headers) : undefined,
        detail: `code ${code}`,
      });
    }
    return {
      result: Object.hasOwn(json, 'result') ? json.result : undefined,
      date: Number.isFinite(date) ? date : undefined,
    };
  }
}
