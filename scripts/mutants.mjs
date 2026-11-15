// -----------------------------------------------------------------------------
// The mutants the tests must kill: each one breaks a guard of the code; the
// suite (`node --test test/*.test.js`) must then fail. The unmodified suite
// runs first ("baseline FAILED" and exit 1 when it is red). One mutant at a
// time, in a copy of the repository made in a fresh temporary directory
// (`.git` left out, `node_modules` copied, never linked; removed after), the
// repository itself never touched; each run bounded in time (its whole
// process group killed past the deadline).
//
// Usage: node scripts/mutants.mjs [name filter]   (wrap it in memcap on a dev VM)
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DEADLINE = 300_000;

const A = 'src/app.js';
const M = 'src/model.js';
const S = 'src/store.js';

export const MUTANTS = [
  // Stops (turn off, close).
  [
    'stop cuts a stuck read',
    A,
    'this.readAbort?.abort();\n    stop.attempts += 1;',
    'stop.attempts += 1;',
  ],
  [
    'stop ignores the budget',
    A,
    'if (!protective && this.memory.budget.calls >= this.config.dailyCalls) return false;',
    'if (this.memory.budget.calls >= this.config.dailyCalls) return false;',
  ],
  [
    'stop decides on a read that left 3 s after the send',
    A,
    'if (left - stop.lastSendAt < 3_000) return;',
    '',
  ],
  [
    'stop never fights a newer change',
    A,
    'time !== undefined && stop.serverAt !== undefined && time > stop.serverAt',
    'false',
  ],
  ['stop resent twice at most', A, 'stop.resends >= TIMINGS.stopResends) {', 'false) {'],
  [
    'stop held by a refusal seen now',
    A,
    'if (this.keysRefusedProven() || this.grantRefusedProven()) return T.stopRefusedAuth;',
    '',
  ],
  [
    'stop kept in /data at most 2 minutes',
    S,
    'if (now - at > TIMINGS.stopMaxAge || keys.has',
    'if (keys.has',
  ],
  // Commands that start something.
  [
    'stop after the click wins',
    A,
    'async () => {\n      if ((this.stopGen.get(lane) ?? 0) !== gen) return { refused: T.supersededByStop };',
    'async () => {',
  ],
  [
    'checked again before the send',
    A,
    'const again = this.startProblem(did, cmd);\n      if (again) return { refused: again };',
    '',
  ],
  ['start refused in a pause', A, 'if (this.paused()) return T.pausedCommand;', ''],
  ['start refused offline', A, 'if (this.online.get(did) === false) return T.offline;', ''],
  ['start refused without /data', A, "if (this.memoryState !== 'ok') return T.storeCommand;", ''],
  [
    'device list fresh',
    A,
    'this.listAt === undefined || this.monotonic() - this.listAt > this.listMaxAge()',
    'this.listAt === undefined',
  ],
  [
    '5xx of one command never pauses',
    A,
    "pause. A 5xx of one command never pauses the others.\n    if (err.kind === 'rate') this.pause(err);",
    "pause. A 5xx of one command never pauses the others.\n    if (err.kind === 'rate' || err.kind === 'server') this.pause(err);",
  ],
  ['lane per endpoint', A, 'this.inCommandLane(lane, async', "this.inCommandLane('all', async"],
  [
    'locks never commanded',
    M,
    'const commandable = ![...all].some((t) => NEVER_COMMANDED.has(t));',
    'const commandable = true;',
  ],
  // Values.
  [
    'a read older than the command says nothing',
    A,
    '(this.commandAt.get(`${ref.did}|e${feature.endpoint}`) ?? -Infinity) >= left',
    'false',
  ],
  [
    'offline publishes nothing',
    A,
    'if (this.online.get(ref.did) === false || value === undefined) continue;',
    'if (value === undefined) continue;',
  ],
  ['measurement at most 2 h old', A, '|| now - time > TIMINGS.valueMaxAge', ''],
  [
    'measurement once per source date',
    A,
    'if ((this.memory.seen.get(featureId) ?? 0) >= time) continue;',
    '',
  ],
  // Credentials, tokens, code.
  [
    'permission on a secondary route is no refusal',
    A,
    "if (!['permission', 'refused', 'device', 'bad', 'too-large'].includes(err.kind)) return false;",
    "if (!['refused', 'device', 'bad', 'too-large'].includes(err.kind)) return false;",
  ],
  [
    'renewed a day before expiry',
    A,
    'if (token.expires - this.now() > TIMINGS.tokenRenewBefore) return;',
    'return;',
  ],
  ['code spacing kept in /data', A, 'this.memory.codeAt = this.now();', ''],
  [
    'test button tries despite a mark',
    A,
    'const wasRefused = this.keysRefused();',
    'const wasRefused = false;',
  ],
  // Review r1 (the reviewer's mutants, adapted to the code; "new keys keep the refusal" is
  // equivalent: the mark of other keys differs 63 times in 64, left out).
  [
    'sendStop ignores stopped',
    A,
    'if (this.stopped || this.stops.get(key) !== stop || stop.inflight) {',
    'if (this.stops.get(key) !== stop || stop.inflight) {',
  ],
  [
    'code request beyond the budget',
    A,
    'if (!this.countCall(false)) return T.budgetSpent(this.config.dailyCalls);\n    // The time of the request',
    'if (!this.countCall(true)) return T.budgetSpent(this.config.dailyCalls);\n    // The time of the request',
  ],
  [
    'code spacing on wall clock only',
    A,
    'Math.min(since < 0 ? 0 : since, sinceMono)',
    '(since < 0 ? 0 : since)',
  ],
  [
    'OnOff on any endpoint type',
    M,
    'if (onoff && onoff.readable && (isLight || isSwitch)) {',
    'if (onoff && onoff.readable) {',
  ],
  ['brightness above 100 accepted', M, '(level.max === undefined || level.max <= 100)', 'true'],
  [
    'contact meaning swapped',
    M,
    'return b === feature.openWhenTrue ? OPENING.OPEN : OPENING.CLOSED;',
    'return b === feature.openWhenTrue ? OPENING.CLOSED : OPENING.OPEN;',
  ],
  [
    'start ignores per-trait code',
    A,
    '      const code = res.result?.data?.[0]?.code;\n      if (code !== undefined && code !== 0) {\n        return {',
    '      const code = res.result?.data?.[0]?.code;\n      if (false) {\n        return {',
  ],
  [
    'stop ignores per-trait code',
    A,
    'const code = res.result?.data?.[0]?.code;\n        if (code !== undefined && code !== 0) {',
    'const code = res.result?.data?.[0]?.code;\n        if (false) {',
  ],
  [
    'stop: 602 refused, not retried',
    A,
    "return TRANSIENT_CODES.has(code) ? 'not-sent' : 'refused';",
    "return 'refused';",
  ],
  [
    'renewal overwrites a newer authorization',
    A,
    'if (this.tokens()?.refresh !== tokens.refresh) return; // replaced meanwhile',
    '// replaced meanwhile',
  ],
  [
    'refused renewal not kept',
    A,
    "if (err.kind === 'refresh') {\n        this.grantRefusedNow();",
    "if (err.kind === 'refresh') {",
  ],
  ['start does not wait for a stop in flight', A, 'if (stop.inflight) await stop.inflight;', ''],
  ['stop retry does not wait for a start', A, 'if (stop.holdWait) {', 'if (false) {'],
  [
    'restart reads at once',
    A,
    'return elapsed >= 0 ? Math.max(0, this.config.pollMs - elapsed) : 0;',
    'return 0;',
  ],
  ['test button spacing', A, 'if (since < TIMINGS.testSpacing) {', 'if (false) {'],
  [
    'attempt not saved before the read',
    A,
    '    // The time of the attempt is in /data before the read (a restart never reads sooner).\n    await this.save();',
    '',
  ],
  [
    'poll minimum',
    'src/config.js',
    'Math.min(Math.max(seconds * 1000, TIMINGS.pollMin), TIMINGS.pollMax)',
    'Math.min(seconds * 1000, TIMINGS.pollMax)',
  ],
  [
    'renewal not counted',
    A,
    "    if (!this.countCall(protective)) throw new ApiError('budget', { sent: false });\n    let res;",
    '    let res;',
  ],
  [
    'stop before config dropped',
    A,
    'if (ready !== T.stopNoConfig) this.endStop(key);\n      return ready.en;',
    'this.endStop(key);\n      return ready.en;',
  ],
  ['older write placed over newer', S, 'if (seq < placed) {', 'if (false) {'],
  [
    'stale state published',
    'src/publisher.js',
    'if (now - entry.at > TIMINGS.stateFresh) {',
    'if (false) {',
  ],
  [
    '429 HTTP not a pause',
    'src/api.js',
    "if (status === 429)\n      throw new ApiError('rate'",
    "if (false)\n      throw new ApiError('rate'",
  ],
  [
    'measurement published before created',
    A,
    'if (!this.created(featureId)) continue;\n          this.memory.seen.delete',
    'this.memory.seen.delete',
  ],
  [
    'future source date accepted',
    A,
    'if (time > now + TIMINGS.futureSkew || now - time > TIMINGS.valueMaxAge) continue;',
    'if (now - time > TIMINGS.valueMaxAge) continue;',
  ],
  [
    'answer size unbounded',
    'src/http.js',
    "        if (size > maxBytes) {\n          fail('too-large');",
    "        if (false) {\n          fail('too-large');",
  ],
  [
    'follow-up reads ignore the pause',
    A,
    'const entries = due.filter((e) => e.protective || !this.paused());',
    'const entries = due;',
  ],
  [
    'code not saved before the request',
    A,
    '    this.memory.codeAt = this.now();\n    await this.save();',
    '    this.memory.codeAt = this.now();',
  ],
  [
    'config retry no backoff',
    A,
    'const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];',
    'const wait = TIMINGS.configRetry[0];',
  ],
  // Corrections of review r1.
  [
    'I1 positions written',
    M,
    '        writable: false,\n        write: target',
    '        writable: Boolean(commandable && target?.writable),\n        write: target',
  ],
  [
    'I2 a stop waits for the renewal',
    A,
    'if (!protective) await this.renewSoon(false);',
    'await this.renewSoon(protective);',
  ],
  [
    'I2 no check right before the bytes',
    A,
    '      if (guard) {\n        const why = guard();\n        if (why) throw new ApiError(why, { sent: false });\n      }',
    '',
  ],
  ['I2 a late start not cut', A, '        if (!left) abort.abort();', ''],
  [
    'I3 2013 refuses the keys',
    'src/constants.js',
    'KEYS: new Set([106, 107, 2002]),',
    'KEYS: new Set([106, 107, 2002, 2013]),',
  ],
  [
    'I4 a fresh token refused ends the grant',
    A,
    "          throw new ApiError('fresh-token', { sent: true, code: err.code });",
    "          this.grantRefusedNow();\n          throw new ApiError('grant', { sent: true, code: err.code });",
  ],
  [
    'I4 no spacing after a fresh token refused',
    A,
    '    if (this.tokenWait.until > this.monotonic()) {\n      this.schedulePoll(',
    '    if (false) {\n      this.schedulePoll(',
  ],
  [
    'M1 a request after stop()',
    A,
    "      if (this.stopped || gen !== this.generation) throw new ApiError('aborted', { sent: false });",
    '',
  ],
  [
    'M2 a refused refresh token sent again',
    A,
    "    if (this.grantRefused() || this.grantRefusedProven())\n      throw new ApiError('grant', { sent: false });\n    if (this.stopped)",
    '    if (this.stopped)',
  ],
  [
    'M2 the test button lifts a refused grant',
    A,
    '    if (this.grantRefused() || this.grantRefusedProven()) return T.grantRefused;\n    if (this.paused())',
    '    if (this.paused())',
  ],
  [
    'M3 list age not tied to the interval',
    A,
    'return Math.max(TIMINGS.listMaxAge, 2 * (this.config?.pollMs ?? 0));',
    'return TIMINGS.listMaxAge;',
  ],
  [
    'M4 resent without a source date',
    A,
    'if (time === undefined || stop.resends >= TIMINGS.stopResends) {',
    'if (stop.resends >= TIMINGS.stopResends) {',
  ],
  ['M5 hearth commanded', 'src/constants.js', "  'Hearth',\n", ''],
  [
    'M6 a stop dropped without a word',
    A,
    '          if (this.stops.get(key) === stop) this.stopUnconfirmed(stop);',
    '          if (this.stops.get(key) === stop) this.endStop(key);',
  ],
];

async function run(dir) {
  // `node --test test/*.test.js`, the glob expanded here.
  const files = (await readdir(join(dir, 'test'))).filter((f) => f.endsWith('.test.js')).sort();
  return new Promise((resolve) => {
    const args = ['--test', '--test-timeout=60000', ...files.map((f) => `test/${f}`)];
    const child = spawn(process.execPath, args, {
      cwd: dir,
      stdio: 'ignore',
      detached: true,
      shell: false,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      resolve('timeout');
    }, DEADLINE);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'survived' : 'killed');
    });
  });
}

/** A copy of the repository (no `.git`; `node_modules` copied, never linked). */
async function copy(dir) {
  await cp(REPO, dir, {
    recursive: true,
    filter: (src) => !/[/\\]\.git$/.test(src),
  });
}

async function main() {
  const filter = process.argv[2];
  const survivors = [];
  // The unmodified suite first: a red baseline would make every mutant look killed.
  const base = await mkdtemp(join(tmpdir(), 'aqara-baseline-'));
  try {
    await copy(base);
    const outcome = await run(base);
    if (outcome !== 'survived') {
      console.log(`baseline FAILED (${outcome})`);
      process.exitCode = 1;
      return;
    }
    console.log('baseline ok');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  for (const [name, file, from, to] of MUTANTS) {
    if (filter && !name.includes(filter)) continue;
    const dir = await mkdtemp(join(tmpdir(), 'aqara-mutant-'));
    try {
      await copy(dir);
      const path = join(dir, file);
      const text = await readFile(path, 'utf8');
      const count = text.split(from).length - 1;
      if (count !== 1) {
        console.log(`STALE   ${name}: found ${count} times in ${file}`);
        survivors.push(name);
        continue;
      }
      await writeFile(path, text.replace(from, to));
      const outcome = await run(dir);
      console.log(`${outcome.toUpperCase().padEnd(8)}${name}`);
      if (outcome !== 'killed') survivors.push(name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  console.log(survivors.length ? `Not killed: ${survivors.join(', ')}` : 'Every mutant killed');
  process.exitCode = survivors.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
