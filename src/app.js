// -----------------------------------------------------------------------------
// AqaraApp: configuration, authorization (verification code, tokens), reads
// of the Aqara Open API, states, Discovery, commands, the stops (turn off,
// close) and the buttons.
//
// Clocks: `monotonic` for every decision (intervals, pauses, deadlines),
// `now` (wall) only for /data, the Time header of the requests, the token
// expiry, the day of the call budget and the age of a measurement against the
// Date of the answer. Timers come from `timers` (tests drive a virtual clock).
//
// Lanes: the reads (device list, descriptions, values, follow-up reads), one
// at a time: one read request in flight per account. The commands that start
// something, one at a time per endpoint (never across devices). Stops never
// wait in a lane: they leave at once, abort a read in flight (which then
// counts as nothing), and are independent of a pause, the daily budget, the
// device list and /data.
// -----------------------------------------------------------------------------

import { ApiError, AqaraApi } from './api.js';
import { grantText, keysText, normalizeConfig } from './config.js';
import { INTENT, LIMITS, TIMINGS, TOKEN_VALIDITY } from './constants.js';
import { T, join } from './i18n.js';
import {
  boolOf,
  buildDevice,
  commandOf,
  deviceIds,
  didOf,
  featureFromParams,
  featuresOf,
  isMatter,
  parseDevicePage,
  parseExternalId,
  parseMatter,
  parseModels,
  reachableOf,
  valueOf,
  writeOf,
} from './model.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, mark, normalizeMemory, serializeMemory } from './store.js';

const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
];

/** The features of the created device that the new build lacks, kept as they are (never a lost feature). */
export function keepCreatedFeatures(built, created) {
  if (!created) return built;
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/** A promise bounded in time: resolves `onTimeout()` (or rejects) past `ms`. */
function bounded(promise, ms, timers, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => timers.clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = timers.setTimeout(() => {
        try {
          resolve(onTimeout());
        } catch (err) {
          reject(err);
        }
      }, ms);
    }),
  ]);
}

const refusal = (text) => Object.assign(new Error(text.en), { text });
const TOKEN_RE = /^[\x21-\x7e]{8,512}$/;
const CODE_RE = /^[A-Za-z0-9]{4,12}$/;
/** Kinds of a failed stop send that are worth trying again (nothing was applied, it may pass later). */
const TRANSIENT = new Set(['rate', 'server', 'network', 'timeout', 'budget', 'fresh-token']);
const TRANSIENT_CODES = new Set([602, 612]);

/** The tokens of an authorization answer, else undefined. */
function tokensOf(result) {
  const access = result?.accessToken;
  const refresh = result?.refreshToken;
  if (typeof access !== 'string' || !TOKEN_RE.test(access)) return undefined;
  if (typeof refresh !== 'string' || !TOKEN_RE.test(refresh)) return undefined;
  const seconds = Number(result.expiresIn);
  return {
    access,
    refresh,
    expiresMs:
      Number.isFinite(seconds) && seconds > 0 && seconds <= 31 * 86_400
        ? seconds * 1000
        : undefined,
  };
}

export class AqaraApp {
  constructor({
    gladys,
    logger,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
    request,
    baseUrl,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.request = request;
    this.baseUrl = baseUrl;
    this.generation = 0;
    this.stopped = false;
    /** Normalized configuration, undefined until read. */
    this.config = undefined;
    this.api = undefined;
    /** Tokens renewed by the module that Gladys has not saved yet (used meanwhile). */
    this.pendingTokens = undefined;
    this.replacedTokens = undefined;
    this.grantKey = undefined;
    /** /data: 'none' | 'loading' | 'ok' | 'unreadable'. */
    this.memoryState = 'none';
    this.memory = emptyMemory();
    this.pauseUntil = 0; // monotonic
    /** did -> device of the last list; descriptions by model (or did for Matter). */
    this.devices = new Map();
    this.descriptions = new Map();
    this.listAt = undefined; // monotonic
    this.forceList = false;
    this.lastRead = undefined; // monotonic time of the last read attempt
    this.lastResult = undefined;
    /** did -> online (Reachable of the last read, else the state of the list). */
    this.online = new Map();
    /** `${did}|e${endpoint}` -> monotonic time of the last command accepted. */
    this.commandAt = new Map();
    /** `${did}|e${endpoint}` -> counter bumped at each stop (a command queued before never leaves after it). */
    this.stopGen = new Map();
    /** `${did}|${key}` -> stop. */
    this.stops = new Map();
    this.lostStops = [];
    /** featureId -> { did, feature, due: [monotonic], protective } follow-up reads. */
    this.follow = new Map();
    this.followTimer = undefined;
    this.readLane = Promise.resolve();
    this.commandLanes = new Map();
    /** lane -> starts not answered yet `{ abort, left() }` (a stop cuts the ones not gone). */
    this.startsInFlight = new Map();
    this.readAbort = undefined;
    this.sleeps = new Map();
    this.pollTimer = undefined;
    this.configTimer = undefined;
    this.storeTimer = undefined;
    this.configTries = 0;
    this.secondary = { failures: 0, until: 0 };
    this.tokenWait = { failures: 0, until: 0 };
    this.refreshing = undefined;
    this.authorizing = undefined;
    this.statusKey = undefined;
    this.discoveryKey = undefined;
    this.saving = undefined;
    this.saveAgain = false;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Every connection to Gladys: /data, the configuration, then status, Discovery and the reads. */
  async connected() {
    this.stopped = false;
    const gen = ++this.generation;
    this.publisher.clear();
    this.publisher.start();
    this.statusKey = undefined;
    this.discoveryKey = undefined;
    if (!this.loading && (this.memoryState === 'none' || this.memoryState === 'unreadable')) {
      this.loading = this.loadMemory().finally(() => {
        this.loading = undefined;
      });
    }
    if (this.loading) await this.loading;
    if (gen !== this.generation) return;
    await this.readConfig(gen);
  }

  async stop() {
    this.stopped = true;
    this.generation += 1;
    this.publisher.stop();
    for (const name of ['pollTimer', 'configTimer', 'storeTimer', 'followTimer']) {
      if (this[name]) this.timers.clearTimeout(this[name]);
      this[name] = undefined;
    }
    this.readAbort?.abort();
    for (const stop of this.stops.values()) {
      if (stop.timer) this.timers.clearTimeout(stop.timer);
      stop.timer = undefined;
    }
    for (const [handle, resolve] of this.sleeps) {
      this.timers.clearTimeout(handle);
      resolve();
    }
    this.sleeps.clear();
    await bounded(
      (async () => {
        if (this.saving) await this.saving;
        await this.save();
      })(),
      TIMINGS.storeTimeout,
      this.timers,
      () => false,
    );
  }

  async loadMemory() {
    this.memoryState = 'loading';
    let raw;
    try {
      raw = await bounded(this.store.load(), TIMINGS.storeTimeout, this.timers, () => {
        throw new Error('timeout');
      });
    } catch (err) {
      this.memoryState = 'unreadable';
      this.logger?.warn(`/data unreadable (${err.code ?? err.message}); read again in 10 s`);
      if (this.storeTimer) this.timers.clearTimeout(this.storeTimer);
      this.storeTimer = this.timers.setTimeout(() => {
        this.storeTimer = undefined;
        if (this.stopped) return;
        this.loadMemory().then(() => this.memoryState === 'ok' && this.afterLoad());
      }, TIMINGS.storeRetry);
      this.publishStatus();
      return;
    }
    const now = this.now();
    const memory = raw === null ? emptyMemory() : normalizeMemory(raw, now);
    // Stops clicked meanwhile (/data was unreadable) win over the file.
    for (const stop of memory.stops) {
      const key = `${stop.did}|${stop.key}`;
      if (!this.stops.has(key)) {
        const atMono = this.monotonic() - Math.min(Math.max(0, now - stop.at), TIMINGS.stopMaxAge);
        this.stops.set(key, { ...stop, atMono, resends: 0, timer: undefined, inflight: undefined });
      }
    }
    // Calls counted meanwhile are kept.
    if (this.memory.budget.day === memory.budget.day) {
      memory.budget.calls = Math.max(memory.budget.calls, this.memory.budget.calls);
    }
    this.memory = memory;
    this.pauseUntil = memory.pause.until > now ? this.monotonic() + (memory.pause.until - now) : 0;
    this.memoryState = 'ok';
  }

  afterLoad() {
    if (this.config) {
      this.resumeStops();
      this.schedulePoll(this.firstDelay());
    }
    this.publishStatus();
  }

  async readConfig(gen) {
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      if (gen !== this.generation) return;
      const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.logger?.warn(`Configuration not read (${err.message}); next try in ${wait} ms`);
      this.setStatus(false, T.configNotRead(wait), 'config');
      if (this.configTimer) this.timers.clearTimeout(this.configTimer);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        if (gen === this.generation) this.readConfig(gen);
      }, wait);
      return;
    }
    if (gen !== this.generation) return;
    this.configTries = 0;
    this.applyConfig(raw, { first: true });
  }

  async configUpdated(raw) {
    if (this.stopped) return;
    this.applyConfig(raw, { first: false });
  }

  /** The tokens in use: renewed ones not saved yet, else the configured ones. */
  tokens() {
    return this.pendingTokens ?? this.config?.tokens;
  }

  applyConfig(raw, { first }) {
    const config = normalizeConfig(raw);
    const before = this.config;
    if (this.pendingTokens) {
      const typed = config.tokens;
      if (typed && typed.refresh === this.pendingTokens.refresh) {
        // Gladys saved them: nothing pending any more.
        this.pendingTokens = undefined;
      } else if (!typed || typed.refresh === this.replacedTokens?.refresh) {
        // A renewal Gladys has not saved yet: still the tokens in use.
      } else {
        // Tokens typed by the user (or a new authorization) win.
        this.pendingTokens = undefined;
      }
    }
    if (
      this.savedTokens &&
      config.tokens &&
      config.tokens.refresh === this.replacedTokens?.refresh &&
      config.tokens.refresh !== this.savedTokens.refresh
    ) {
      // A late echo of the tokens our renewal replaced (they no longer work): the saved ones stay.
      config.tokens = this.savedTokens;
    }
    const keysChanged = !before || keysText(before) !== keysText(config);
    this.config = config;
    const grant = grantText(config, this.tokens());
    const grantChanged = this.grantKey !== grant;
    this.grantKey = grant;
    if (keysChanged && before && this.memory.keysRefused) {
      // New keys are always tried: the mark only serves after a restart.
      this.memory.keysRefused = undefined;
      this.keysRefusedText = undefined;
      this.save();
    }
    if (grantChanged && before && this.memory.grantRefused) {
      this.memory.grantRefused = undefined;
      this.grantRefusedText = undefined;
      this.save();
    }
    if (keysChanged) {
      this.api = config.keys
        ? new AqaraApi(config, {
            baseUrl: this.baseUrl,
            now: this.now,
            request: this.request,
            timers: this.timers,
          })
        : undefined;
      if (
        before &&
        (before.region !== config.region || before.keys?.appId !== config.keys?.appId)
      ) {
        this.devices.clear();
        this.descriptions.clear();
        this.online.clear();
        this.listAt = undefined;
      }
      this.secondary = { failures: 0, until: 0 };
    }
    this.publishDiscovery();
    this.publishStatus();
    this.resumeStops();
    if (first) {
      this.schedulePoll(this.firstDelay());
    } else if (keysChanged || grantChanged) {
      // New keys or a new authorization: read now (a pause still holds).
      this.schedulePoll(0);
    }
  }

  firstDelay() {
    if (this.lastRead !== undefined) {
      return Math.max(0, this.lastRead + this.config.pollMs - this.monotonic());
    }
    const last = this.memory.lastAttempt;
    if (last === undefined) return 0;
    const elapsed = this.now() - last;
    return elapsed >= 0 ? Math.max(0, this.config.pollMs - elapsed) : 0;
  }

  // --- /data -------------------------------------------------------------------

  /** Saves /data (coalesced, bounded); never when it was not read (never overwritten blind). */
  save() {
    if (this.memoryState !== 'ok') return Promise.resolve(false);
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    this.memory.stops = [...this.stops.values()].map(({ did, key, at, sent, attempts }) => ({
      did,
      key,
      at,
      sent,
      attempts,
    }));
    const data = serializeMemory(this.memory);
    this.saving = bounded(
      this.store.save(data).then(() => true),
      TIMINGS.storeTimeout,
      this.timers,
      () => false,
    )
      .catch((err) => {
        this.logger?.warn(`/data not written (${err.code ?? err.message})`);
        return false;
      })
      .finally(() => {
        this.saving = undefined;
        if (this.saveAgain && !this.stopped) {
          this.saveAgain = false;
          this.save();
        }
      });
    return this.saving;
  }

  // --- Guards ----------------------------------------------------------------

  keysMark() {
    return mark(this.memory.salt, keysText(this.config));
  }

  grantMark() {
    return mark(this.memory.salt, grantText(this.config, this.tokens()));
  }

  keysRefused() {
    return Boolean(this.config && this.memory.keysRefused?.mark === this.keysMark());
  }

  grantRefused() {
    return Boolean(
      this.config && this.tokens() && this.memory.grantRefused?.mark === this.grantMark(),
    );
  }

  /** Refusals seen while the module runs (proof, not a 6-bit mark): they hold the stops too. */
  keysRefusedProven() {
    return Boolean(this.config && this.keysRefusedText === keysText(this.config));
  }

  grantRefusedProven() {
    return Boolean(this.config && this.grantRefusedText === grantText(this.config, this.tokens()));
  }

  paused() {
    return this.pauseUntil > this.monotonic();
  }

  /** Reads can start: keys, tokens, no refusal. */
  ready() {
    return Boolean(
      this.config &&
      this.api &&
      this.tokens() &&
      this.config.tokenErrors.length === 0 &&
      !this.keysRefused() &&
      !this.grantRefused(),
    );
  }

  /** Any configured key, token or the account, masked in a text that leaves the module. */
  redact(text) {
    let out = String(text);
    const secrets = [
      this.config?.keys?.appKey,
      this.config?.tokens?.access,
      this.config?.tokens?.refresh,
      this.pendingTokens?.access,
      this.pendingTokens?.refresh,
      this.replacedTokens?.access,
      this.replacedTokens?.refresh,
      this.config?.account,
    ].filter((s) => typeof s === 'string' && s.length >= 4);
    for (const s of secrets) out = out.split(s).join('***');
    return out.slice(0, LIMITS.message);
  }

  // --- Daily budget --------------------------------------------------------------

  today() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  budgetLeft() {
    const day = this.today();
    if (this.memory.budget.day !== day) return this.config?.dailyCalls ?? 0;
    return Math.max(0, (this.config?.dailyCalls ?? 0) - this.memory.budget.calls);
  }

  /** Counts one call before it leaves; false when the budget of the day is spent (stops always pass). */
  countCall(protective) {
    const day = this.today();
    if (this.memory.budget.day !== day) this.memory.budget = { day, calls: 0 };
    if (!protective && this.memory.budget.calls >= this.config.dailyCalls) return false;
    this.memory.budget.calls += 1;
    if (this.memory.budget.calls % 20 === 0) this.save();
    return true;
  }

  // --- API calls -----------------------------------------------------------------

  /**
   * One API request with the access token: renewed first when it expires
   * soon, renewed and tried once again when Aqara says it expired. Counted
   * in the daily budget. Throws an ApiError ('grant' when the authorization
   * is over, 'budget' when nothing was sent for the budget).
   */
  async call(intent, data, { protective = false, signal, timeoutMs, onSent, guard } = {}) {
    const api = this.api;
    const gen = this.generation;
    if (!api) throw new ApiError('config', { sent: false });
    if (!this.tokens()) throw new ApiError('grant', { sent: false });
    // A stop never waits for a renewal while its token has not expired.
    if (!protective) await this.renewSoon(false);
    for (let attempt = 0; ; attempt += 1) {
      // Nothing leaves after stop(); a start checks again right before its bytes (stop, deadline).
      if (this.stopped || gen !== this.generation) throw new ApiError('aborted', { sent: false });
      if (guard) {
        const why = guard();
        if (why) throw new ApiError(why, { sent: false });
      }
      if (signal?.aborted) throw new ApiError('aborted', { sent: false });
      if (!this.countCall(protective)) throw new ApiError('budget', { sent: false });
      try {
        return await api.call(intent, data, {
          accessToken: this.tokens()?.access,
          timeoutMs,
          signal,
          onSent,
          // Checked again at the connection, right before the first byte.
          beforeSend: () =>
            !this.stopped && gen === this.generation && !(guard && guard()) && !signal?.aborted,
        });
      } catch (err) {
        if (err.kind === 'keys') this.keysRefusedNow();
        const tokenRefused = err.kind === 'expired' || err.kind === 'token';
        // After a fresh token was refused, no renewal while the spacing runs (a stop is sent
        // with the current token; refused, it is "not sent" and tried again later).
        if (tokenRefused && this.tokenWait.until > this.monotonic()) {
          throw new ApiError('fresh-token', { sent: true, code: err.code });
        }
        if (tokenRefused && attempt === 0) {
          await this.refreshTokens({ protective });
          continue;
        }
        if (tokenRefused) {
          // Refused just after an accepted renewal: no proof the authorization is over
          // (the refresh token was just accepted). Not read, spaced (renewals too, doubled up
          // to an hour); nothing is held by it.
          this.tokenWait.failures += 1;
          this.tokenWait.until =
            this.monotonic() +
            Math.min(
              (this.config?.pollMs ?? 60_000) * 2 ** this.tokenWait.failures,
              TIMINGS.secondaryMax,
            );
          throw new ApiError('fresh-token', { sent: true, code: err.code });
        }
        throw err;
      }
    }
  }

  /** The access token renewed when Aqara said it expires within a day (known expiry of these tokens). */
  async renewSoon(protective) {
    const token = this.memory.token;
    const tokens = this.tokens();
    if (!token || !tokens || token.mark !== mark(this.memory.salt, tokens.refresh)) return;
    if (token.expires - this.now() > TIMINGS.tokenRenewBefore) return;
    try {
      await this.refreshTokens({ protective });
    } catch (err) {
      if (err.kind === 'grant') throw err;
      // Not renewed now (network, pause): the current token is still tried.
      this.logger?.warn(`Access token not renewed (${err.kind})`);
    }
  }

  /** Renews the tokens (one renewal at a time); a refused renewal ends the authorization. */
  refreshTokens({ protective = false } = {}) {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(protective).finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  async doRefresh(protective) {
    const tokens = this.tokens();
    const api = this.api;
    if (!tokens || !api) throw new ApiError('grant', { sent: false });
    // A refresh token Aqara refused is never sent again (not by a click, not by a stop).
    if (this.grantRefused() || this.grantRefusedProven())
      throw new ApiError('grant', { sent: false });
    if (this.stopped) throw new ApiError('aborted', { sent: false });
    if (!this.countCall(protective)) throw new ApiError('budget', { sent: false });
    let res;
    try {
      res = await api.call(
        INTENT.REFRESH_TOKEN,
        { refreshToken: tokens.refresh },
        { timeoutMs: TIMINGS.readTimeout },
      );
    } catch (err) {
      if (err.kind === 'keys') this.keysRefusedNow();
      if (err.kind === 'refresh') {
        this.grantRefusedNow();
        throw new ApiError('grant', { sent: true, code: err.code });
      }
      if (err.kind === 'rate' || err.kind === 'server') this.pause(err);
      throw err;
    }
    const fresh = tokensOf(res.result);
    if (!fresh) throw new ApiError('bad', { detail: 'no token in the renewal' });
    if (this.tokens()?.refresh !== tokens.refresh) return; // replaced meanwhile (a new authorization)
    await this.useTokens(fresh);
  }

  /** New tokens: used at once, saved in the configuration of Gladys (never in /data). */
  async useTokens(fresh) {
    this.replacedTokens = this.tokens();
    this.savedTokens = undefined;
    this.pendingTokens = { access: fresh.access, refresh: fresh.refresh };
    this.grantKey = grantText(this.config, this.pendingTokens);
    this.memory.grantRefused = undefined;
    this.grantRefusedText = undefined;
    this.memory.token = fresh.expiresMs
      ? { mark: mark(this.memory.salt, fresh.refresh), expires: this.now() + fresh.expiresMs }
      : undefined;
    this.save();
    return this.saveTokens();
  }

  async saveTokens() {
    const pending = this.pendingTokens;
    if (!pending) return true;
    try {
      await this.gladys.setConfig({ access_token: pending.access, refresh_token: pending.refresh });
      // Saved in Gladys: the configuration in use holds them now.
      if (this.pendingTokens === pending) {
        this.pendingTokens = undefined;
        this.savedTokens = pending;
        if (this.config) this.config.tokens = pending;
      }
      this.publishStatus();
      return true;
    } catch (err) {
      this.logger?.warn(`Tokens not saved in Gladys (${this.redact(err.message)})`);
      this.publishStatus();
      return false;
    }
  }

  keysRefusedNow() {
    if (!this.config) return;
    this.keysRefusedText = keysText(this.config);
    this.memory.keysRefused = { mark: this.keysMark() };
    this.save();
    this.publishStatus();
  }

  grantRefusedNow() {
    if (!this.config || !this.tokens()) return;
    this.grantRefusedText = grantText(this.config, this.tokens());
    this.memory.grantRefused = { mark: this.grantMark() };
    this.save();
    this.publishStatus();
  }

  // --- Status and Discovery ----------------------------------------------------

  setStatus(connected, message, key = message.en) {
    const text = { en: this.redact(message.en), fr: this.redact(message.fr) };
    const id = `${connected}|${text.en}|${key}`;
    if (id === this.statusKey) return;
    this.statusKey = id;
    this.gladys
      .setConnectionStatus(connected, text)
      .catch((err) => this.logger?.warn(`Status not sent: ${err.message}`));
  }

  publishStatus() {
    if (this.memoryState === 'unreadable') {
      this.setStatus(false, T.storeUnreadable);
      return;
    }
    const config = this.config;
    if (!config) return;
    const extra = [];
    if (this.lostStops.length) extra.push(T.stopLost(this.lostStops.slice(0, 10)));
    if (this.pendingTokens) extra.push(T.tokensNotSaved);
    if (config.accountInvalid) extra.push(T.accountInvalid);
    if (config.errors.length) {
      this.setStatus(false, join(T.configMissing(config.errors), ...extra));
      return;
    }
    if (this.keysRefused()) {
      this.setStatus(false, join(T.keysRefused, ...extra));
      return;
    }
    if (config.tokenErrors.length) {
      this.setStatus(false, join(T.configMissing(config.tokenErrors), ...extra));
      return;
    }
    if (!this.tokens()) {
      this.setStatus(false, join(T.notAuthorized, ...extra));
      return;
    }
    if (this.grantRefused()) {
      this.setStatus(false, join(T.grantRefused, ...extra));
      return;
    }
    if (this.paused()) {
      this.setStatus(false, join(T.paused(this.pauseUntil - this.monotonic()), ...extra), 'paused');
      return;
    }
    if (this.budgetLeft() <= 0) {
      this.setStatus(false, join(T.budgetSpent(config.dailyCalls), ...extra), 'budget');
      return;
    }
    const r = this.lastResult;
    if (!r) return;
    if (r.ok) {
      if (this.secondary.failures) extra.unshift(T.partlyRead);
      this.setStatus(
        true,
        join(T.connected(this.devices.size, this.featureCount()), ...extra),
        'ok',
      );
    } else {
      this.setStatus(false, join(T.failure(r.kind, r.code), ...extra));
    }
  }

  featureCount() {
    let n = 0;
    for (const device of this.devices.values()) n += this.featuresOfDevice(device).length;
    return n;
  }

  descriptionOf(device) {
    return this.descriptions.get(isMatter(device.model) ? device.did : device.model);
  }

  featuresOfDevice(device) {
    return featuresOf(this.descriptionOf(device));
  }

  discovered() {
    if (!this.config) return [];
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    const list = [];
    for (const device of this.devices.values()) {
      const built = buildDevice(this.gladys, device, this.featuresOfDevice(device));
      if (built) list.push(keepCreatedFeatures(built, created.get(built.external_id)));
    }
    return list;
  }

  publishDiscovery(force = false) {
    const list = this.discovered();
    const key = JSON.stringify(list);
    if (!force && key === this.discoveryKey) return Promise.resolve();
    this.discoveryKey = key;
    return this.gladys
      .publishDiscoveredDevices(list)
      .catch((err) => this.logger?.warn(`Discovery not sent: ${err.message}`));
  }

  /** Discovery: what the last reads gave (never a read sooner than the interval); the list is read again at the next one. */
  async scan() {
    this.forceList = true;
    await this.publishDiscovery(true);
  }

  async deviceCreated() {
    // Nothing republished: a value already sent is never sent again as new.
  }

  async deviceDeleted(device) {
    if (device?.external_id) this.publisher.forget(device.external_id);
  }

  created(featureId) {
    return (this.gladys.devices ?? []).some((d) =>
      (d.features ?? []).some((f) => f.external_id === featureId),
    );
  }

  createdDevice(did) {
    const id = deviceIds(this.gladys, did).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === id);
  }

  push(featureId, state, options) {
    if (this.created(featureId)) this.publisher.push(featureId, state, options);
  }

  // --- Reads -------------------------------------------------------------------

  schedulePoll(delay) {
    if (this.stopped) return;
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = this.timers.setTimeout(
      () => {
        this.pollTimer = undefined;
        this.poll().catch((err) => this.logger?.error(`Read failed: ${err.message}`));
      },
      Math.max(0, delay),
    );
  }

  async poll() {
    const gen = this.generation;
    if (this.stopped || !this.config) return;
    if (this.memoryState !== 'ok') return; // read again once /data is (afterLoad)
    if (!this.ready()) {
      this.publishStatus();
      return;
    }
    if (this.paused()) {
      this.publishStatus();
      this.schedulePoll(this.pauseUntil - this.monotonic() + 1);
      return;
    }
    if (this.tokenWait.until > this.monotonic()) {
      this.schedulePoll(this.tokenWait.until - this.monotonic() + 1);
      return;
    }
    await this.read(gen);
    if (gen !== this.generation || this.stopped) return;
    let next = this.paused() ? this.pauseUntil - this.monotonic() + 1 : this.config.pollMs;
    if (this.tokenWait.until > this.monotonic())
      next = Math.max(next, this.tokenWait.until - this.monotonic() + 1);
    if (this.ready()) this.schedulePoll(next);
  }

  inReadLane(fn) {
    const run = this.readLane.then(fn, fn);
    this.readLane = run.catch(() => {});
    return run;
  }

  read(gen) {
    return this.inReadLane(() => this.doRead(gen));
  }

  async doRead(gen) {
    if (gen !== this.generation || !this.ready() || this.paused()) return this.lastResult;
    if (this.budgetLeft() <= 0) {
      this.publishStatus();
      return this.lastResult;
    }
    const started = this.monotonic();
    this.lastRead = started;
    this.memory.lastAttempt = this.now();
    // The time of the attempt is in /data before the read (a restart never reads sooner).
    await this.save();
    if (gen !== this.generation) return this.lastResult;
    // Renewed tokens Gladys could not save yet: saved again now.
    if (this.pendingTokens && this.pendingTokens.refresh !== this.config.tokens?.refresh) {
      await this.saveTokens();
      if (gen !== this.generation) return this.lastResult;
    }
    const abort = new AbortController();
    this.readAbort = abort;
    try {
      if (
        this.forceList ||
        this.listAt === undefined ||
        this.monotonic() - this.listAt >= TIMINGS.listEvery
      ) {
        await this.readList(abort.signal, started);
        this.forceList = false;
      }
      if (gen !== this.generation) return this.lastResult;
      await this.readDescriptions(abort.signal);
      if (gen !== this.generation) return this.lastResult;
      const refs = this.valueRefs([...this.devices.values()]);
      await this.readValues(refs, abort.signal, started);
    } catch (err) {
      if (gen !== this.generation) return this.lastResult;
      if (err.kind === 'aborted') {
        // Cut by a stop: counts as nothing (read again at the next interval).
        this.lastRead = undefined;
        return this.lastResult;
      }
      this.readFailed(err);
      return this.lastResult;
    } finally {
      if (this.readAbort === abort) this.readAbort = undefined;
    }
    if (gen !== this.generation) return this.lastResult;
    this.pauseOk();
    this.tokenWait = { failures: 0, until: 0 };
    this.lastResult = { ok: true };
    this.publishDiscovery();
    this.publishStatus();
    this.save();
    return this.lastResult;
  }

  async readList(signal, started) {
    const devices = new Map();
    for (let page = 1; page <= Math.ceil(LIMITS.devices / LIMITS.pageSize); page += 1) {
      const res = await this.call(
        INTENT.DEVICES,
        { pageNum: page, pageSize: LIMITS.pageSize },
        { signal, timeoutMs: TIMINGS.readTimeout },
      );
      const parsed = parseDevicePage(res.result);
      if (!parsed) throw new ApiError('bad', { detail: 'no device list' });
      for (const device of parsed.devices) {
        if (devices.size < LIMITS.devices) devices.set(device.did, device);
      }
      const total = parsed.total ?? 0;
      if (parsed.count < LIMITS.pageSize || page * LIMITS.pageSize >= total) break;
    }
    this.devices = devices;
    this.listAt = started;
    for (const device of devices.values()) this.online.set(device.did, device.online);
    for (const did of [...this.online.keys()]) if (!devices.has(did)) this.online.delete(did);
  }

  /** The descriptions of the models not known yet (a secondary route: its failure never stops the values). */
  async readDescriptions(signal) {
    if (this.secondary.until > this.monotonic()) return;
    const models = new Set();
    const matter = [];
    for (const device of this.devices.values()) {
      if (isMatter(device.model)) {
        if (!this.descriptions.has(device.did)) matter.push(device.did);
      } else if (!this.descriptions.has(device.model)) {
        models.add(device.model);
      }
    }
    const modelList = [...models];
    try {
      for (let i = 0; i < modelList.length; i += LIMITS.modelsPerCall) {
        const chunk = modelList.slice(i, i + LIMITS.modelsPerCall);
        const res = await this.call(
          INTENT.MODELS,
          { models: chunk },
          { signal, timeoutMs: TIMINGS.readTimeout },
        );
        const parsed = parseModels(res.result);
        for (const model of chunk) {
          // A model the API does not describe stays known as empty (asked again after a restart).
          this.descriptions.set(model, parsed.get(model) ?? { types: [], endpoints: [] });
        }
      }
      for (let i = 0; i < matter.length; i += LIMITS.matterPerCall) {
        const chunk = matter.slice(i, i + LIMITS.matterPerCall);
        const res = await this.call(
          INTENT.MATTER,
          { dids: chunk },
          { signal, timeoutMs: TIMINGS.readTimeout },
        );
        const parsed = parseMatter(res.result);
        for (const did of chunk) {
          this.descriptions.set(did, parsed.get(did) ?? { types: [], endpoints: [] });
        }
      }
      this.secondary = { failures: 0, until: 0 };
    } catch (err) {
      if (!this.secondaryFailed(err)) throw err;
    }
  }

  /** A secondary route failed: spaced (doubled up to an hour) when it is a permission or a refusal; true when handled. */
  secondaryFailed(err) {
    if (!['permission', 'refused', 'device', 'bad', 'too-large'].includes(err.kind)) return false;
    this.secondary.failures += 1;
    const wait = Math.min(this.config.pollMs * 2 ** this.secondary.failures, TIMINGS.secondaryMax);
    this.secondary.until = this.monotonic() + wait;
    this.logger?.warn(`Device descriptions not read (${this.redact(err.message)})`);
    return true;
  }

  /** The traits to read for some devices: `[{ did, endpointId, functionCode, traitCode, feature? }]`. */
  valueRefs(devices) {
    const refs = [];
    for (const device of devices) {
      const description = this.descriptionOf(device);
      const reach = reachableOf(description);
      if (reach) refs.push({ did: device.did, endpointId: reach.endpoint, ...reach, reach: true });
      for (const feature of featuresOf(description)) {
        refs.push({
          did: device.did,
          endpointId: feature.endpoint,
          functionCode: feature.functionCode,
          traitCode: feature.traitCode,
          feature,
        });
      }
    }
    return refs;
  }

  /** Reads the values of `refs` (chunks of 50) and applies them. */
  async readValues(refs, signal, started, { protective = false } = {}) {
    for (let i = 0; i < refs.length; i += LIMITS.traitsPerCall) {
      const chunk = refs.slice(i, i + LIMITS.traitsPerCall);
      const left = this.monotonic();
      const res = await this.call(
        INTENT.TRAITS,
        {
          traits: chunk.map((r) => ({
            deviceId: r.did,
            endpointId: r.endpointId,
            functionCode: r.functionCode,
            traitCode: r.traitCode,
          })),
        },
        { signal, timeoutMs: TIMINGS.readTimeout, protective },
      );
      const data = res.result?.data;
      if (!Array.isArray(data)) throw new ApiError('bad', { detail: 'no trait values' });
      this.applyValues(
        chunk,
        data.slice(0, LIMITS.traitsPerCall * 2),
        res.date,
        Math.max(left, started ?? left),
      );
    }
  }

  applyValues(refs, data, serverDate, left) {
    const byKey = new Map();
    for (const entry of data) {
      if (entry === null || typeof entry !== 'object') continue;
      const did = didOf(entry.deviceId);
      if (!did || !Number.isInteger(entry.endpointId) || typeof entry.traitCode !== 'string')
        continue;
      byKey.set(`${did}|${entry.endpointId}|${entry.traitCode}`, entry);
    }
    const now = serverDate ?? this.now();
    // The online state first (the Reachable trait), then the values of the online devices.
    for (const ref of refs.filter((r) => r.reach)) {
      const entry = byKey.get(`${ref.did}|${ref.endpointId}|${ref.traitCode}`);
      const b = boolOf(entry?.value);
      if (b !== undefined) this.online.set(ref.did, b);
    }
    let changed = false;
    for (const ref of refs.filter((r) => r.feature)) {
      const entry = byKey.get(`${ref.did}|${ref.endpointId}|${ref.traitCode}`);
      if (!entry) continue;
      const feature = ref.feature;
      const value = valueOf(feature, entry.value);
      const time = Number.isFinite(entry.time) && entry.time > 0 ? entry.time : undefined;
      const featureId = deviceIds(this.gladys, ref.did).feature(feature.key);
      const commanded = ['onoff', 'brightness', 'position'].includes(feature.kind);
      if (commanded) this.checkStop(ref.did, feature, value, time, left);
      if (this.online.get(ref.did) === false || value === undefined) continue;
      if (
        commanded &&
        (this.commandAt.get(`${ref.did}|e${feature.endpoint}`) ?? -Infinity) >= left
      ) {
        // A read that left before the last command of this endpoint says nothing of it.
        continue;
      }
      if (feature.kind === 'measure') {
        if (time !== undefined) {
          if (time > now + TIMINGS.futureSkew || now - time > TIMINGS.valueMaxAge) continue;
          if ((this.memory.seen.get(featureId) ?? 0) >= time) continue;
          if (!this.created(featureId)) continue;
          this.memory.seen.delete(featureId);
          this.memory.seen.set(featureId, time);
          changed = true;
        }
        this.push(featureId, value, { spaced: true });
      } else {
        this.push(featureId, value);
      }
    }
    while (this.memory.seen.size > LIMITS.seen)
      this.memory.seen.delete(this.memory.seen.keys().next().value);
    if (changed) this.save();
  }

  readFailed(err) {
    this.logger?.warn(`Aqara read failed (${this.redact(err.message)})`);
    if (err.kind === 'rate' || err.kind === 'server') this.pause(err);
    this.lastResult = {
      ok: false,
      kind: err.kind === 'too-large' ? 'bad' : err.kind,
      code: err.code,
    };
    this.publishStatus();
  }

  /** 429 / 5xx: a pause, doubled at each one in a row (Retry-After when longer), bounded, in /data. */
  pause(err) {
    const failures = Math.min(this.memory.pause.failures + 1, 20);
    const doubled = Math.min(TIMINGS.pauseMin * 2 ** (failures - 1), TIMINGS.pauseMax);
    const wait = Math.min(Math.max(doubled, err.retryAfter ?? 0), TIMINGS.pauseMax);
    this.pauseUntil = this.monotonic() + wait;
    this.memory.pause = { until: this.now() + wait, failures };
    this.save();
    this.publishStatus();
  }

  pauseOk() {
    if (this.memory.pause.failures || this.memory.pause.until) {
      this.memory.pause = { until: 0, failures: 0 };
      this.pauseUntil = 0;
    }
  }

  // --- Follow-up reads (confirmation) ------------------------------------------

  /** Reads of a commanded value 5 s and 20 s after its send (grouped, in the read lane). */
  followUp(did, feature, protective) {
    const featureId = deviceIds(this.gladys, did).feature(feature.key);
    const base = this.monotonic();
    this.follow.set(featureId, {
      did,
      feature,
      protective,
      due: TIMINGS.followUps.map((d) => base + d),
    });
    this.planFollow();
  }

  planFollow() {
    if (this.stopped) return;
    if (this.followTimer) this.timers.clearTimeout(this.followTimer);
    this.followTimer = undefined;
    let next = Infinity;
    for (const entry of this.follow.values()) next = Math.min(next, entry.due[0]);
    if (next === Infinity) return;
    this.followTimer = this.timers.setTimeout(
      () => {
        this.followTimer = undefined;
        this.runFollow().catch((err) => this.logger?.warn(`Follow-up read failed: ${err.message}`));
      },
      Math.max(0, next - this.monotonic()),
    );
  }

  async runFollow() {
    const at = this.monotonic();
    const due = [];
    for (const [id, entry] of this.follow) {
      if (entry.due[0] > at) continue;
      entry.due.shift();
      if (entry.due.length === 0) this.follow.delete(id);
      due.push(entry);
    }
    this.planFollow();
    if (due.length === 0) return;
    const protective = due.some((e) => e.protective);
    const entries = due.filter((e) => e.protective || !this.paused());
    if (entries.length === 0 || !this.api || !this.tokens()) return;
    if (!protective && (this.paused() || !this.ready())) return;
    const refs = entries.map((e) => ({
      did: e.did,
      endpointId: e.feature.endpoint,
      functionCode: e.feature.functionCode,
      traitCode: e.feature.traitCode,
      feature: e.feature,
    }));
    // A stop read before its description is known (right after a restart): its value trait is not known either.
    const known = refs.filter((r) => r.functionCode);
    if (known.length === 0) return;
    await this.inReadLane(async () => {
      try {
        await this.readValues(known, undefined, undefined, { protective });
      } catch (err) {
        if (err.kind === 'rate' || err.kind === 'server') this.pause(err);
        this.logger?.warn(`Follow-up read failed (${this.redact(err.message)})`);
      }
    });
  }

  // --- Commands ----------------------------------------------------------------

  /** A command from Gladys. Turning off is never held; anything else is checked first. */
  async setValue(device, feature, value) {
    const target = parseExternalId(feature?.external_id, `ext:${this.gladys.selector}:`);
    if (!target) throw refusal(T.invalidValue);
    const { did, key } = target;
    const listed = this.devices.get(did);
    const features = listed ? this.featuresOfDevice(listed) : [];
    const createdDevice = device?.params ? device : this.createdDevice(did);
    const find = (k) => features.find((f) => f.key === k) ?? featureFromParams(createdDevice, k);
    const feat = find(key);
    if (!feat) throw refusal(T.notKnown);
    let cmd;
    if (feat.kind === 'brightness' && value === 0) {
      const onoff = find(`e${feat.endpoint}-onoff`);
      cmd = onoff ? commandOf(onoff, 0) : undefined;
    } else {
      cmd = commandOf(feat, value, features);
    }
    if (!cmd) throw refusal(T.invalidValue);
    if (!cmd.feature.writable) throw refusal(T.notCommandable);
    if (cmd.protective) return this.turnOff(did, cmd);
    return this.start(did, cmd);
  }

  // --- Stops -------------------------------------------------------------------

  /**
   * Turn off / close: sent at once (a read in flight is cut), whatever a
   * pause, the daily budget, the device list or /data; confirmed by the
   * reads 5 s and 20 s later (sent again when contradicted, twice at most);
   * a send that fails for a passing reason is tried again (6 tries, 2 min).
   */
  async turnOff(did, cmd) {
    const feature = cmd.feature;
    const key = `${did}|${feature.key}`;
    const lane = `${did}|e${feature.endpoint}`;
    this.stopGen.set(lane, (this.stopGen.get(lane) ?? 0) + 1);
    this.commandAt.set(lane, this.monotonic());
    // Every start of this endpoint not gone yet is cut (a connection in progress included);
    // one already gone may reach Aqara after this stop: its value is never taken for a newer change.
    let raced = false;
    for (const start of this.startsInFlight.get(lane) ?? []) {
      if (start.left()) raced = true;
      else start.abort.abort();
    }
    const old = this.stops.get(key);
    if (old?.timer) this.timers.clearTimeout(old.timer);
    if (old) old.ended = true;
    const stop = {
      did,
      key: feature.key,
      feature,
      at: this.now(),
      atMono: this.monotonic(),
      sent: 0,
      attempts: 0,
      resends: 0,
      raced,
      timer: undefined,
      inflight: undefined,
    };
    this.stops.set(key, stop);
    this.lostStops = this.lostStops.filter((n) => n !== this.stopName(stop));
    this.save();
    const ready = this.stopReady(stop);
    if (ready !== true) {
      if (ready !== T.stopNoConfig) this.endStop(key);
      return ready.en;
    }
    const deadline = this.monotonic() + TIMINGS.commandAck;
    let outcome = await this.sendStop(stop, deadline);
    if (
      outcome === 'not-sent' &&
      this.monotonic() + TIMINGS.stopRetry < deadline &&
      this.stops.get(key) === stop
    ) {
      await this.sleep(TIMINGS.stopRetry);
      if (!this.stopped && this.stops.get(key) === stop && !stop.inflight)
        outcome = await this.sendStop(stop, deadline);
    }
    if (outcome === 'sent') return T.sent.en;
    if (outcome === 'no-answer') return T.sentNoAnswer.en;
    if (outcome === 'refused') return T.stopRefused(stop.lastError ?? 'error').en;
    return T.stopNotSent.en;
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const handle = this.timers.setTimeout(() => {
        this.sleeps.delete(handle);
        resolve();
      }, ms);
      this.sleeps.set(handle, resolve);
    });
  }

  stopAge(stop) {
    return this.monotonic() - stop.atMono;
  }

  stopName(stop) {
    return this.devices.get(stop.did)?.name ?? `Aqara ${stop.did}`;
  }

  /** true, or the text of why a stop cannot leave now. */
  stopReady(stop) {
    if (!this.config) return T.stopNoConfig;
    if (!this.api) return T.stopNoKeys;
    if (!this.tokens()) return T.stopNoGrant;
    // A mark kept in /data is a hint only (64 values): a stop is held only by a refusal seen now.
    if (this.keysRefusedProven() || this.grantRefusedProven()) return T.stopRefusedAuth;
    if (!stop.feature) {
      const device = this.createdDevice(stop.did);
      stop.feature = featureFromParams(device, stop.key);
      if (!stop.feature) return T.stopNoTarget;
    }
    return true;
  }

  resumeStops() {
    for (const [key, stop] of this.stops) {
      if (stop.timer || stop.inflight) continue;
      if (this.stopAge(stop) > TIMINGS.stopMaxAge) {
        this.endStop(key);
        continue;
      }
      const ready = this.stopReady(stop);
      if (ready === true) this.sendStop(stop);
      else if (ready !== T.stopNoConfig) this.endStop(key);
    }
  }

  /** A stop no read confirmed: ended and named in the status. */
  stopUnconfirmed(stop) {
    this.lostStops = [
      ...this.lostStops.filter((n) => n !== this.stopName(stop)),
      this.stopName(stop),
    ].slice(-10);
    this.publishStatus();
    this.endStop(`${stop.did}|${stop.key}`);
  }

  endStop(key) {
    const stop = this.stops.get(key);
    if (!stop) return;
    if (stop.timer) this.timers.clearTimeout(stop.timer);
    stop.timer = undefined;
    stop.ended = true;
    this.stops.delete(key);
    this.save();
  }

  /** The value a stop writes (turn off: false; positions are read only in v1). */
  stopValue() {
    return false;
  }

  /**
   * One send of a stop. Resolves 'sent' (Aqara accepted it), 'no-answer'
   * (it left, no answer by `deadline`), 'refused', 'not-sent'. The request
   * goes on after the deadline; its answer counts.
   */
  sendStop(stop, deadline) {
    const key = `${stop.did}|${stop.key}`;
    if (this.stopped || this.stops.get(key) !== stop || stop.inflight) {
      return Promise.resolve('not-sent');
    }
    if (this.stopReady(stop) !== true) return Promise.resolve('not-sent');
    // A read in flight never delays a stop: cut it (it counts as nothing).
    this.readAbort?.abort();
    stop.attempts += 1;
    stop.lastSendAt = this.monotonic();
    let left = false;
    const write = writeOf(stop.feature);
    const request = this.call(
      INTENT.WRITE,
      {
        traits: [
          {
            deviceId: stop.did,
            endpointId: stop.feature.endpoint,
            functionCode: write.functionCode,
            traitCode: write.traitCode,
            value: this.stopValue(stop),
          },
        ],
      },
      { protective: true, timeoutMs: TIMINGS.commandTimeout, onSent: () => (left = true) },
    ).then(
      (res) => {
        const code = res.result?.data?.[0]?.code;
        if (code !== undefined && code !== 0) {
          stop.lastError = `code ${Number.isInteger(code) ? code : '?'}`;
          return TRANSIENT_CODES.has(code) ? 'not-sent' : 'refused';
        }
        // The Date header counts whole seconds: a change within that second is taken as ours.
        stop.serverAt = (res.date ?? this.now()) + 1_000;
        return 'sent';
      },
      (err) => {
        this.logger?.warn(`Stop of ${stop.did}: ${this.redact(err.message)}`);
        if (err.kind === 'rate') this.pause(err);
        if (err.kind === 'device' && TRANSIENT_CODES.has(err.code)) return 'not-sent';
        if (err.sent || left) {
          if (['timeout', 'network'].includes(err.kind)) return 'failed-sent';
        }
        if (TRANSIENT.has(err.kind)) return 'not-sent';
        if (err.kind === 'aborted') return 'not-sent';
        stop.lastError = err.code !== undefined ? `code ${err.code}` : err.kind;
        return 'refused';
      },
    );
    stop.inflight = request;
    request.then((result) => {
      stop.inflight = undefined;
      if (stop.ended || this.stops.get(key) !== stop) return;
      if (result === 'refused' || this.keysRefusedProven() || this.grantRefusedProven()) {
        this.endStop(key);
        return;
      }
      if (result === 'sent' || result === 'failed-sent') {
        if (result === 'sent') stop.sent += 1;
        this.commandAt.set(`${stop.did}|e${stop.feature.endpoint}`, this.monotonic());
        // Confirmed (or sent again) by the reads that follow.
        this.followUp(stop.did, stop.feature, true);
      }
      this.planStop(stop, result);
    });
    if (deadline === undefined) return request;
    return bounded(request, Math.max(0, deadline - this.monotonic()), this.timers, () =>
      left ? 'no-answer' : 'not-sent',
    ).then((r) => (r === 'failed-sent' ? 'no-answer' : r));
  }

  /** After a send: kept for its follow-up reads, or tried again after a failure, or ended. */
  planStop(stop, result) {
    const key = `${stop.did}|${stop.key}`;
    if (this.stopped || this.stops.get(key) !== stop) return;
    const age = this.stopAge(stop);
    if (result === 'sent' || result === 'failed-sent') {
      // The follow-up reads decide; the stop ends anyway past its last read.
      if (stop.timer) this.timers.clearTimeout(stop.timer);
      const last = TIMINGS.followUps[TIMINGS.followUps.length - 1];
      stop.timer = this.timers.setTimeout(
        () => {
          stop.timer = undefined;
          // No read showed it off in time: said, never taken as done.
          if (this.stops.get(key) === stop) this.stopUnconfirmed(stop);
        },
        last + TIMINGS.readTimeout + 1_000,
      );
      this.save();
      return;
    }
    if (stop.attempts >= TIMINGS.stopAttempts || age > TIMINGS.stopMaxAge) {
      if (stop.sent === 0) {
        this.lostStops = [
          ...this.lostStops.filter((n) => n !== this.stopName(stop)),
          this.stopName(stop),
        ].slice(-10);
        this.publishStatus();
      }
      this.endStop(key);
      return;
    }
    this.save();
    if (stop.timer) this.timers.clearTimeout(stop.timer);
    stop.timer = this.timers.setTimeout(async () => {
      stop.timer = undefined;
      if (stop.holdWait) {
        await bounded(stop.holdWait, TIMINGS.commandTimeout, this.timers, () => undefined);
        if (this.stopped || this.stops.get(key) !== stop) return;
      }
      this.sendStop(stop);
    }, TIMINGS.stopRetrySpacing);
  }

  /**
   * A value read for a feature under a stop: the expected one ends it
   * (confirmed); another one, read at least 3 s after the send, sends it
   * again (twice at most) unless the source date shows it changed after the
   * stop (the Aqara app, a switch, an automation: never fought).
   */
  checkStop(did, feature, value, time, left) {
    const key = `${did}|${feature.key}`;
    const stop = this.stops.get(key);
    if (!stop || stop.inflight || stop.lastSendAt === undefined) return;
    if (left - stop.lastSendAt < 3_000) return;
    // Off (0) or closed (0).
    if (value === 0) {
      this.endStop(key);
      return;
    }
    if (value === undefined) return;
    if (!stop.raced && time !== undefined && stop.serverAt !== undefined && time > stop.serverAt) {
      this.endStop(key);
      return;
    }
    // Without a source date it may have been turned on again after the stop (the Aqara app, a
    // wall switch): never fought, said as not confirmed.
    if (time === undefined || stop.resends >= TIMINGS.stopResends) {
      this.stopUnconfirmed(stop);
      return;
    }
    stop.resends += 1;
    if (stop.timer) this.timers.clearTimeout(stop.timer);
    stop.timer = undefined;
    this.sendStop(stop);
  }

  // --- Commands that start something -------------------------------------------

  startProblem(did, cmd) {
    if (this.memoryState !== 'ok') return T.storeCommand;
    if (!this.config || !this.api) return T.notConfigured;
    if (!this.tokens()) return T.notAuthorized;
    if (this.keysRefused()) return T.keysRefused;
    if (this.grantRefused()) return T.grantRefused;
    if (this.paused()) return T.pausedCommand;
    if (this.budgetLeft() <= 0) return T.budgetSpent(this.config.dailyCalls);
    const device = this.devices.get(did);
    if (!device) return T.notKnown;
    if (this.listAt === undefined || this.monotonic() - this.listAt > this.listMaxAge())
      return T.listOld;
    const feature = this.featuresOfDevice(device).find((f) => f.key === cmd.feature.key);
    if (!feature || !feature.writable) return T.notCommandable;
    if (this.online.get(did) === false) return T.offline;
    return undefined;
  }

  /** The age past which the device list is too old for a start: 15 minutes, or two read intervals. */
  listMaxAge() {
    return Math.max(TIMINGS.listMaxAge, 2 * (this.config?.pollMs ?? 0));
  }

  inCommandLane(key, fn) {
    const before = this.commandLanes.get(key) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const tail = run.catch(() => {});
    this.commandLanes.set(key, tail);
    tail.then(() => {
      if (this.commandLanes.get(key) === tail) this.commandLanes.delete(key);
    });
    return run;
  }

  async start(did, cmd) {
    const problem = this.startProblem(did, cmd);
    if (problem) throw refusal(problem);
    const feature = cmd.feature;
    const lane = `${did}|e${feature.endpoint}`;
    const gen = this.stopGen.get(lane) ?? 0;
    const deadline = this.monotonic() + TIMINGS.commandAck;
    let left = false;
    let settled = false;
    // Cut at the deadline when it has not left yet: a start answered "nothing sent" never leaves later.
    const abort = new AbortController();
    const guard = () => {
      if ((this.stopGen.get(lane) ?? 0) !== gen) return 'superseded';
      if (settled || this.monotonic() >= deadline) return 'late';
      return undefined;
    };
    const entry = { abort, left: () => left };
    if (!this.startsInFlight.has(lane)) this.startsInFlight.set(lane, new Set());
    this.startsInFlight.get(lane).add(entry);
    const work = this.inCommandLane(lane, async () => {
      if ((this.stopGen.get(lane) ?? 0) !== gen) return { refused: T.supersededByStop };
      if (this.monotonic() >= deadline || settled) return { refused: T.notSentCommand('timeout') };
      const again = this.startProblem(did, cmd);
      if (again) return { refused: again };
      const held = [...this.stops.values()].filter(
        (s) => s.did === did && s.feature?.endpoint === feature.endpoint,
      );
      for (const stop of held) {
        if (stop.inflight) await stop.inflight;
      }
      if ((this.stopGen.get(lane) ?? 0) !== gen) return { refused: T.supersededByStop };
      if (this.monotonic() >= deadline || settled) return { refused: T.notSentCommand('timeout') };
      const call = this.call(
        INTENT.WRITE,
        {
          traits: [
            {
              deviceId: did,
              endpointId: feature.endpoint,
              functionCode: cmd.write.functionCode,
              traitCode: cmd.write.traitCode,
              value: cmd.value,
            },
          ],
        },
        {
          timeoutMs: TIMINGS.commandTimeout,
          onSent: () => (left = true),
          signal: abort.signal,
          guard,
        },
      );
      const wait = call.then(
        () => undefined,
        () => undefined,
      );
      for (const stop of held) stop.holdWait = wait;
      let res;
      try {
        res = await call;
      } catch (err) {
        return { error: err };
      } finally {
        for (const stop of held) if (stop.holdWait === wait) stop.holdWait = undefined;
      }
      const code = res.result?.data?.[0]?.code;
      if (code !== undefined && code !== 0) {
        return { refused: T.failedCommand(`code ${Number.isInteger(code) ? code : '?'}`) };
      }
      // It left and Aqara accepted it: newer than any stop of this endpoint.
      this.commandAt.set(lane, this.monotonic());
      for (const stop of held) {
        if (this.stops.get(`${stop.did}|${stop.key}`) === stop)
          this.endStop(`${stop.did}|${stop.key}`);
      }
      this.followUp(did, feature, false);
      return { ok: true };
    });
    work
      .finally(() => {
        this.startsInFlight.get(lane)?.delete(entry);
        if (this.startsInFlight.get(lane)?.size === 0) this.startsInFlight.delete(lane);
      })
      .catch(() => {});
    const result = await bounded(
      work,
      Math.max(0, deadline - this.monotonic()),
      this.timers,
      () => {
        settled = true;
        if (!left) abort.abort();
        return { late: true };
      },
    );
    settled = true;
    if (result.late) {
      if (left) return T.sentNoAnswer.en;
      throw refusal(T.notSentCommand('timeout'));
    }
    if (result.ok) return T.sent.en;
    if (result.refused) throw refusal(result.refused);
    const err = result.error;
    if (err.kind === 'superseded' || (!left && (this.stopGen.get(lane) ?? 0) !== gen))
      throw refusal(T.supersededByStop);
    if (err.kind === 'late') throw refusal(T.notSentCommand('timeout'));
    // A 429 is about the account: pause. A 5xx of one command never pauses the others.
    if (err.kind === 'rate') this.pause(err);
    if (!err.sent && !left) throw refusal(T.notSentCommand(err.kind));
    if (err.kind === 'timeout' || err.kind === 'network') return T.sentNoAnswer.en;
    throw refusal(T.failedCommand(err.code !== undefined ? `code ${err.code}` : err.kind));
  }

  // --- Buttons -------------------------------------------------------------------

  /** Asks Aqara to send a verification code to the account: on this click only, never twice within a minute. */
  async sendCode() {
    if (this.memoryState !== 'ok') return T.storeUnreadable;
    if (!this.config) return T.notConfigured;
    if (this.config.errors.length) return T.configMissing(this.config.errors);
    if (!this.config.account) return T.configMissing(['account']);
    if (this.keysRefusedProven()) return T.keysRefused;
    if (this.paused()) return T.paused(this.pauseUntil - this.monotonic());
    const since = this.memory.codeAt === undefined ? Infinity : this.now() - this.memory.codeAt;
    const sinceMono = this.codeSentAt === undefined ? Infinity : this.monotonic() - this.codeSentAt;
    const wait = TIMINGS.codeSpacing - Math.min(since < 0 ? 0 : since, sinceMono);
    if (wait > 0) return T.codeTooSoon(wait);
    if (!this.countCall(false)) return T.budgetSpent(this.config.dailyCalls);
    // The time of the request is in /data before it leaves (a restart never asks again at once).
    this.codeSentAt = this.monotonic();
    this.memory.codeAt = this.now();
    await this.save();
    try {
      await this.api.call(
        INTENT.GET_AUTH_CODE,
        { account: this.config.account, accountType: 0, accessTokenValidity: TOKEN_VALIDITY },
        { timeoutMs: TIMINGS.readTimeout },
      );
    } catch (err) {
      return this.authFailed(err);
    }
    // The answer is never read further nor logged (it may carry the code).
    return T.codeSent;
  }

  authFailed(err) {
    if (err.kind === 'keys') {
      this.keysRefusedNow();
      return T.keysRefused;
    }
    if (err.kind === 'rate' || err.kind === 'server') this.pause(err);
    if (err.kind === 'code-too-often') return T.codeTooOften;
    if (err.kind === 'account') return T.accountRefused;
    if (err.kind === 'auth-code') return T.codeRefused;
    if (err.kind === 'clock') return T.failure('clock');
    return T.actionFailed(err.code !== undefined ? `code ${err.code}` : err.kind);
  }

  /** Exchanges the verification code for the tokens, saved in the configuration of Gladys. */
  async authorize(fields) {
    if (this.authorizing) return T.authorizing;
    this.authorizing = this.doAuthorize(fields).finally(() => {
      this.authorizing = undefined;
    });
    return this.authorizing;
  }

  async doAuthorize(fields) {
    if (this.memoryState !== 'ok') return T.storeUnreadable;
    if (!this.config) return T.notConfigured;
    if (this.config.errors.length) return T.configMissing(this.config.errors);
    if (!this.config.account) return T.configMissing(['account']);
    const code = typeof fields?.code === 'string' ? fields.code.trim() : '';
    if (!CODE_RE.test(code)) return T.codeInvalid;
    if (this.keysRefusedProven()) return T.keysRefused;
    if (this.paused()) return T.paused(this.pauseUntil - this.monotonic());
    if (!this.countCall(false)) return T.budgetSpent(this.config.dailyCalls);
    let res;
    try {
      res = await this.api.call(
        INTENT.GET_TOKEN,
        { authCode: code, account: this.config.account, accountType: 0 },
        { timeoutMs: TIMINGS.readTimeout },
      );
    } catch (err) {
      return this.authFailed(err);
    }
    const fresh = tokensOf(res.result);
    if (!fresh) return T.actionFailed('no token');
    // A new authorization: whatever was refused before is not this one; new keys are tried too.
    this.memory.keysRefused = undefined;
    this.keysRefusedText = undefined;
    const saved = await this.useTokens(fresh);
    this.forceList = true;
    this.schedulePoll(0);
    return saved ? T.authorized : T.tokensNotSaved;
  }

  async testConnection() {
    if (this.memoryState !== 'ok') return T.storeUnreadable;
    if (!this.config) return T.notConfigured;
    if (this.config.errors.length) return T.configMissing(this.config.errors);
    if (this.config.tokenErrors.length) return T.configMissing(this.config.tokenErrors);
    if (!this.tokens()) return T.notAuthorized;
    // A refused refresh token is never sent again by a click: authorize again.
    if (this.grantRefused() || this.grantRefusedProven()) return T.grantRefused;
    if (this.paused()) return T.paused(this.pauseUntil - this.monotonic());
    const since = this.lastRead === undefined ? Infinity : this.monotonic() - this.lastRead;
    if (since < TIMINGS.testSpacing) {
      return join(this.resultText(), T.testTooSoon(TIMINGS.testSpacing - since));
    }
    const gen = this.generation;
    const was = { keys: this.memory.keysRefused, keysText: this.keysRefusedText };
    // The button always tries the keys: a mark may be a collision after a restart.
    const wasRefused = this.keysRefused();
    if (wasRefused) {
      this.memory.keysRefused = undefined;
      this.keysRefusedText = undefined;
    }
    this.tokenWait = { failures: 0, until: 0 };
    this.forceList = true;
    await this.read(gen);
    if (gen === this.generation && this.lastResult?.ok && this.ready()) {
      this.schedulePoll(this.config.pollMs);
    } else if (wasRefused && !this.lastResult?.ok && !this.keysRefused()) {
      // Nothing proved the keys good: still refused.
      this.memory.keysRefused = was.keys;
      this.keysRefusedText = was.keysText;
      this.save();
    }
    this.publishStatus();
    return this.resultText();
  }

  resultText() {
    if (this.keysRefused()) return T.keysRefused;
    if (this.grantRefused()) return T.grantRefused;
    if (this.paused()) return T.paused(this.pauseUntil - this.monotonic());
    if (this.budgetLeft() <= 0) return T.budgetSpent(this.config.dailyCalls);
    const r = this.lastResult;
    if (!r) return T.reading;
    if (!r.ok) return T.failure(r.kind, r.code);
    const devices = [...this.devices.values()].map((d) => ({
      name: d.name,
      model: d.model,
      features: this.featuresOfDevice(d).length,
    }));
    const text = T.testOk(devices, this.budgetLeft());
    return { en: this.redact(text.en), fr: this.redact(text.fr) };
  }
}
