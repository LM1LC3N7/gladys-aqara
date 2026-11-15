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
  ['stop resent twice at most', A, 'if (stop.resends >= TIMINGS.stopResends) {', 'if (false) {'],
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
    'this.listAt === undefined || this.monotonic() - this.listAt > TIMINGS.listMaxAge',
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
    'const wasRefused = this.keysRefused() || this.grantRefused();',
    'const wasRefused = false;',
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
