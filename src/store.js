// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in one small JSON file readable by the container user only
// (0600), written through a temporary file, fsync and rename:
//   - the time of the last read attempt (a restart never reads sooner than
//     the interval) and of the last verification code asked;
//   - the pause after a 429 / 5xx (until, count in a row);
//   - the API calls of the day (the daily budget of the configuration);
//   - after Aqara refused the project keys or the authorization: the refusal
//     and a 6-bit salted mark of what was refused (64 values, says nothing
//     usable of a key), so it is not sent again on its own after a restart;
//   - the expiry of the access token, with the mark of its refresh token;
//   - the stops (turn off, close) still to be sent;
//   - the source date of the last measurement published, per feature (a
//     value never published twice as new).
// Nothing secret: no key, no token, no account.
//
// Bounded: opened without following a link and without waiting (a FIFO is
// refused), 64 KB at most; a save never waits more than `queueWait` for the
// one before it. The app bounds every load and save too.
// -----------------------------------------------------------------------------

import * as fsPromises from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { LIMITS, TIMINGS } from './constants.js';
import { didOf } from './model.js';

export const STATE_FILE = '/data/aqara-state.json';
export const FORMAT = 1;
const MAX_BYTES = 64 * 1024;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

export function fileStore(
  path = STATE_FILE,
  { fs = fsPromises, timers = globalThis, queueWait = TIMINGS.storeQueue } = {},
) {
  let previous = Promise.resolve();
  let count = 0;
  let placed = 0;
  return {
    /** null when there is no file; throws when it cannot be read, is not a plain file or does not parse. */
    async load() {
      let handle;
      try {
        handle = await fs.open(path, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile())
          throw Object.assign(new Error('not a plain file'), { code: 'ESPECIAL' });
        if (stat.size > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'EFBIG' });
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'EFBIG' });
        return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await handle.close().catch(() => {});
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const seq = ++count;
      const before = previous;
      const write = (async () => {
        let timer;
        await Promise.race([
          before,
          new Promise((resolve) => {
            timer = timers.setTimeout(resolve, queueWait);
          }),
        ]);
        timers.clearTimeout(timer);
        if (Buffer.byteLength(text) > MAX_BYTES) {
          throw Object.assign(new Error('too large'), { code: 'EFBIG' });
        }
        const temporary = `${path}.tmp-${seq}`;
        const file = await fs.open(
          temporary,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW | NONBLOCK,
          0o600,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile())
            throw Object.assign(new Error('not a plain file'), { code: 'ESPECIAL' });
          await file.writeFile(text, 'utf8');
          await file.sync();
        } finally {
          await file.close().catch(() => {});
        }
        if (seq < placed) {
          // A newer state is in place (this write hung meanwhile): never put back over it.
          await fs.unlink(temporary).catch(() => {});
          return;
        }
        await fs.rename(temporary, path);
        placed = Math.max(placed, seq);
      })();
      previous = write.catch(() => {});
      return write;
    },
  };
}

/** The same in memory (tests): `fail` makes the saves throw, `unreadable` the loads, `hang` both wait forever. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : structuredClone(initial),
    saves: 0,
    loads: 0,
    fail: false,
    unreadable: false,
    hang: false,
    async load() {
      this.loads += 1;
      if (this.hang) return new Promise(() => {});
      if (this.unreadable) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const int = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;
const SEEN_KEY =
  /^ext:[A-Za-z0-9_-]{1,64}:device:[A-Za-z0-9]{1,24}-[A-Za-z0-9_-]{1,64}:e(?:0|[1-9]\d{0,3})-[a-z0-9]{1,16}$/;
const STOP_KEY = /^e(?:0|[1-9]\d{0,3})-(?:onoff|position)$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const wall = (value, now) =>
  Number.isFinite(value) && value > 0 && value <= now ? value : undefined;
const MARK_MAX = 63;

export const emptyMemory = () => ({
  format: FORMAT,
  salt: randomBytes(16).toString('hex'),
  lastAttempt: undefined,
  codeAt: undefined,
  pause: { until: 0, failures: 0 },
  budget: { day: '', calls: 0 },
  keysRefused: undefined,
  grantRefused: undefined,
  token: undefined,
  stops: [],
  seen: new Map(),
});

const markOf = (raw) => {
  const m = int(own(raw, 'mark'), 0, MARK_MAX);
  return m === undefined ? undefined : { mark: m };
};

/**
 * The file read back, repaired: only known keys of the expected shape (never
 * an inherited or `__proto__` key). A date in the future (a clock set back, a
 * hand-edited file) is invalid: dropped.
 */
export function normalizeMemory(raw, now) {
  const memory = emptyMemory();
  const salt = own(raw, 'salt');
  if (typeof salt === 'string' && /^[0-9a-f]{32}$/.test(salt)) memory.salt = salt;
  memory.lastAttempt = wall(own(raw, 'lastAttempt'), now);
  memory.codeAt = wall(own(raw, 'codeAt'), now);
  const pause = own(raw, 'pause');
  const until = own(pause, 'until');
  memory.pause = {
    until: Number.isFinite(until) && until > now && until <= now + TIMINGS.pauseMax ? until : 0,
    failures: int(own(pause, 'failures'), 0, 100) ?? 0,
  };
  const budget = own(raw, 'budget');
  const day = own(budget, 'day');
  if (typeof day === 'string' && DAY_RE.test(day)) {
    memory.budget = { day, calls: int(own(budget, 'calls'), 0, 10_000_000) ?? 0 };
  }
  memory.keysRefused = markOf(own(raw, 'keysRefused'));
  memory.grantRefused = markOf(own(raw, 'grantRefused'));
  const token = own(raw, 'token');
  const tokenMark = int(own(token, 'mark'), 0, MARK_MAX);
  const expires = own(token, 'expires');
  if (tokenMark !== undefined && Number.isFinite(expires) && expires > 0) {
    memory.token = { mark: tokenMark, expires };
  }
  const stops = own(raw, 'stops');
  if (Array.isArray(stops)) {
    const keys = new Set();
    for (const entry of stops.slice(0, LIMITS.stops)) {
      const did = didOf(own(entry, 'did'));
      const key = own(entry, 'key');
      const at = wall(own(entry, 'at'), now);
      if (!did || typeof key !== 'string' || !STOP_KEY.test(key) || at === undefined) continue;
      if (now - at > TIMINGS.stopMaxAge || keys.has(`${did}|${key}`)) continue;
      keys.add(`${did}|${key}`);
      memory.stops.push({
        did,
        key,
        at,
        sent: int(own(entry, 'sent'), 0, 9) ?? 0,
        attempts: int(own(entry, 'attempts'), 0, 99) ?? 0,
      });
    }
  }
  const seen = own(raw, 'seen');
  if (isObject(seen)) {
    for (const key of Object.keys(seen).slice(0, LIMITS.seen)) {
      const at = wall(seen[key], now + TIMINGS.futureSkew);
      if (SEEN_KEY.test(key) && at !== undefined) memory.seen.set(key, at);
    }
  }
  return memory;
}

/** The persisted form (plain objects of validated keys only). */
export function serializeMemory(memory) {
  const seen = Object.create(null);
  for (const [key, at] of [...memory.seen].slice(-LIMITS.seen)) seen[key] = at;
  return {
    format: FORMAT,
    salt: memory.salt,
    ...(memory.lastAttempt ? { lastAttempt: memory.lastAttempt } : {}),
    ...(memory.codeAt ? { codeAt: memory.codeAt } : {}),
    pause: { until: memory.pause.until, failures: memory.pause.failures },
    budget: { day: memory.budget.day, calls: memory.budget.calls },
    ...(memory.keysRefused ? { keysRefused: { mark: memory.keysRefused.mark } } : {}),
    ...(memory.grantRefused ? { grantRefused: { mark: memory.grantRefused.mark } } : {}),
    ...(memory.token ? { token: { mark: memory.token.mark, expires: memory.token.expires } } : {}),
    stops: memory.stops.slice(0, LIMITS.stops).map((s) => ({
      did: s.did,
      key: s.key,
      at: s.at,
      sent: s.sent,
      attempts: s.attempts,
    })),
    seen,
  };
}

/**
 * The 6-bit salted mark of a text (keys, a refresh token): 64 values, so it
 * says nothing usable of a key (thousands of keys share each mark). After a
 * restart, other credentials share the mark of the refused ones once in 64:
 * the test button always tries and its success clears the mark; the stops
 * take a mark as a hint only and are sent.
 */
export function mark(salt, text) {
  return createHash('sha256').update(`${salt}\0${text}`).digest()[0] & MARK_MAX;
}
