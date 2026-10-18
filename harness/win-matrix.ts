/**
 * Windows platform matrix for the detached background-task registry.
 *
 * Drives BackgroundTaskRegistry directly (no Pi UI needed) and covers the
 * Windows-specific paths: cmd dialect resolution, the runner script with its
 * nested `cmd /s /c` execution, the `%errorlevel%` exit marker, taskkill tree
 * termination (timeout/cap kills), pid-liveness probing, detached survival
 * across a genuine parent-process exit, and adoption from a dead activation.
 *
 * Companion script: win-spawner.ts (started as a child and abandoned on
 * purpose — it exits while its tasks keep running, simulating a crashed Pi).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveShellPolicy } from '../src/core/common.js';
import { BackgroundTaskRegistry } from '../src/core/registry.js';

const dir = resolve(
  process.env.TEMP ?? process.cwd(),
  `bg-matrix-${randomBytes(3).toString('hex')}`,
);
const notes: string[] = [];
const mk = (cap?: number, pollMs = 250) =>
  new BackgroundTaskRegistry({
    tasksDir: dir,
    pollIntervalMs: pollMs,
    maxOutputBytes: cap ?? 20 * 1024 * 1024,
    sendCompletionNotification: (message) => {
      notes.push(message.content);
    },
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const check: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean) => check.push([name, pass]);

/** '1' while a pid exists, '0' once gone (Windows pid probe via PowerShell). */
function pidCount(pid: number): number {
  const probe = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue | Measure-Object).Count`,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  return probe.stdout === undefined ? -1 : Number(probe.stdout.trim());
}

// 0. shell policy resolves to cmd on this platform
const policy = resolveShellPolicy('win32', process.env, process.cwd());
ok(
  'policy resolves to cmd dialect',
  policy.policy === 'cmd' && policy.dialect === 'cmd' && policy.executable.endsWith('cmd.exe'),
);

// --- activation A ---
const regA = mk();

// 1. natural completion through the runner script
const t1 = await regA.startTask({ cwd: dir, sessionId: 'w' }, 'echo hello-windows & exit 0');
ok(
  'runner script created on disk',
  t1.runnerScriptFile !== undefined && existsSync(t1.runnerScriptFile as string),
);
if (t1.runnerScriptFile !== undefined) {
  ok(
    'runner nests the user command under cmd /s /c',
    readFileSync(t1.runnerScriptFile, 'utf8').includes(
      `cmd.exe" /d /s /c "echo hello-windows & exit 0"`,
    ),
  );
}
await sleep(1500);
const s1 = regA.snapshot(t1);
ok(
  'completed via marker + exit 0 + notified + bytes traced',
  s1.status === 'completed' && s1.exitCode === 0 && s1.notified && s1.bytesWritten > 0,
);
ok(
  'output captured with no quoting mangling',
  readFileSync(t1.outputAbsPath, 'utf8').includes('hello-windows'),
);

// 2. failed exit code comes from %errorlevel% in the marker
const t2 = await regA.startTask({ cwd: dir, sessionId: 'w' }, 'exit 3');
await sleep(1500);
const s2 = regA.snapshot(t2);
ok('failed with exit 3 read from marker', s2.status === 'failed' && s2.exitCode === 3);

// 3. quoting torture: parens, quotes, ampersand must not break the epilogue
const t3 = await regA.startTask(
  { cwd: dir, sessionId: 'w' },
  'echo (parens) and "quo ted" & echo done-flip & exit 0',
);
await sleep(1500);
const s3 = regA.snapshot(t3);
const out3 = readFileSync(t3.outputAbsPath, 'utf8');
ok(
  'parens/quotes/& survive the nested quoting',
  s3.status === 'completed' &&
    out3.includes('(parens)') &&
    out3.includes('"quo ted"') &&
    out3.includes('done-flip'),
);

// 4. timeout kill of a 3-level tree (cmd wrapper -> cmd /c -> waitfor)
const t4 = await regA.startTask(
  { cwd: dir, sessionId: 'w' },
  'cmd /d /s /c waitfor /t 90 TREESIGW',
  { timeoutSeconds: 2 },
);
await sleep(7000); // soft terminate 3s grace, then /T /F force, then finalize
const s4 = regA.snapshot(t4);
ok(
  'timeout kill reports failed + Timed out message',
  s4.status === 'failed' && (s4.error ?? '').startsWith('Timed out after 2s'),
);
ok('tree root process gone (taskkill /T)', t4.pid !== undefined && pidCount(t4.pid) === 0);

// 5. output cap kill
const regCap = mk(4096);
const t5 = await regCap.startTask(
  { cwd: dir, sessionId: 'w' },
  'cmd /c for /l %%i in (1,1,999999) do @echo flooder-xxxxxxxxxxxxxxxxxxxxxx',
);
await sleep(2500);
const s5 = regCap.snapshot(t5);
ok(
  'cap kill with notice written into the output file',
  s5.status === 'failed' &&
    (s5.error ?? '').includes('Output exceeded cap of') &&
    readFileSync(t5.outputAbsPath, 'utf8').includes('Output exceeded cap of'),
);

// 6. detached survival across a genuine parent exit + adoption
process.env.BG_TEST_DIR = dir;
const spawner = spawnSync(
  'cmd',
  // must inherit the refreshed node PATH used by this tsx session
  ['/d', '/s', '/c', 'npx tsx harness/win-spawner.ts'],
  { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 120_000 },
);
if (spawner.stdout === undefined || spawner.stdout.trim().length === 0) {
  console.error('spawner failed:', spawner.stderr, spawner.status);
  process.exit(1);
}
const spawnIds = JSON.parse(spawner.stdout.trim()) as {
  a: string;
  b: string;
  aPid: number;
  bPid: number;
};
ok(
  'spawner exit left the detached pings alive',
  pidCount(spawnIds.aPid) === 1 && pidCount(spawnIds.bPid) === 1,
);

// new activation adopts exactly the two running records
const regB = mk();
const adopted = await regB.reconcileTasksFromDisk();
ok('new activation adopts exactly the 2 orphaned records', adopted === 2);

// 6a. externally killed orphan (no marker): finalized as failed-unknown
const killedExternally = spawnSync('taskkill', ['/F', '/T', '/PID', String(spawnIds.aPid)], {
  encoding: 'utf8',
  timeout: 15_000,
});
if (killedExternally.status !== 0) {
  console.error('external taskkill failed:', killedExternally.stderr);
  process.exit(1);
}
await sleep(1200);
const orphan = regB.resolveTask(spawnIds.a);
ok(
  'externally killed orphan → failed without completion marker',
  orphan.status === 'failed' &&
    (orphan.error ?? '').includes('without writing a completion marker'),
);

// 6b. adopted task killed through the new activation's taskkill machinery
await regB.stopTask(regB.resolveTask(spawnIds.b), 'user');
const killedTask = regB.resolveTask(spawnIds.b);
ok(
  'adoptee stopped via taskkill tree + notification delivered',
  killedTask.status === 'killed' &&
    pidCount(spawnIds.bPid) === 0 &&
    notes.some((n) => n.includes(`<task-id>${spawnIds.b}</task-id>`)),
);

// 7. nothing else adopts once everything is terminal
const regX = mk();
const adoptedAgain = await regX.reconcileTasksFromDisk();
ok('fully-terminal disk adopts nothing', adoptedAgain === 0);

for (const [name, pass] of check) console.log(pass ? '  PASS' : '  FAIL', name);
console.log(check.every(([, pass]) => pass) ? 'ALL PASS' : 'FAILURES PRESENT');
process.exit(check.every(([, pass]) => pass) ? 0 : 1);
