/**
 * POSIX platform matrix for the detached background-task registry.
 *
 * Covers the platform-generic paths on Linux/macOS: POSIX group signal
 * authority, completion markers, timeout/cap kills, detached survival across a
 * genuine parent exit, and adoption from a dead activation.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveShellPolicy } from '../src/core/common.js';
import { BackgroundTaskRegistry } from '../src/core/registry.js';

const dir = join(
  mkdtempSync(join(tmpdir(), `bg-posix-${randomBytes(2).toString('hex')}`)),
  'tasks',
);

const notes: string[] = [];
const mk = (cap?: number, pollMs = 150) =>
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

/** '1' while a pid exists, '0' once gone. */
function pidCount(pid: number): number {
  const probe = spawnSync('sh', ['-c', `kill -0 ${pid} 2>/dev/null && echo 1 || echo 0`], {
    encoding: 'utf8',
  });
  return Number((probe.stdout ?? '0').trim());
}

// 0. shell policy
const policy = resolveShellPolicy('linux', process.env, process.cwd());
ok(
  'policy resolves to a posix shell',
  (policy.policy === 'inherit' || policy.policy === 'cmd') &&
    policy.dialect !== 'none' &&
    policy.executable.length > 0,
);

const regA = mk();

// 1. natural completion through the posix wrapper
const t1 = await regA.startTask({ cwd: dir, sessionId: 'p' }, 'echo hello-posix; exit 0');
await sleep(1500);
const s1 = regA.snapshot(t1);
ok(
  'completed via marker + exit 0 + notified + bytes traced',
  s1.status === 'completed' && s1.exitCode === 0 && s1.notified && s1.bytesWritten > 0,
);
ok('output captured', readFileSync(t1.outputAbsPath, 'utf8').includes('hello-posix'));

// 2. failed exit code comes from the marker
const t2 = await regA.startTask({ cwd: dir, sessionId: 'p' }, 'exit 3');
await sleep(1200);
const s2 = regA.snapshot(t2);
ok('failed with exit 3 read from marker', s2.status === 'failed' && s2.exitCode === 3);

// 3. quoting torture
const t3 = await regA.startTask(
  { cwd: dir, sessionId: 'p' },
  `echo '(posix parens)' && echo "quo ted" && echo done-brr && exit 0`,
);
await sleep(1500);
const s3 = regA.snapshot(t3);
const out3 = readFileSync(t3.outputAbsPath, 'utf8');
ok(
  'quotes/parens survive the wrapper',
  s3.status === 'completed' &&
    out3.includes('(posix parens)') &&
    out3.includes('quo ted') &&
    out3.includes('done-brr'),
);

// 4. timeout kill of a tree (sh -c -> sleep chain)
const t4 = await regA.startTask(
  { cwd: dir, sessionId: 'p' },
  'sh -c "sleep 90; echo late" & sh -c "sleep 90"',
  {
    timeoutSeconds: 2,
  },
);
await sleep(4500);
const s4 = regA.snapshot(t4);
ok(
  'timeout kill reports failed + Timed out',
  s4.status === 'failed' &&
    (s4.error ?? '').startsWith('Timed out after 2s') &&
    pidCount(t4.pid as number) === 0,
);

// 5. output cap kill
const regCap = mk(4096);
const t5 = await regCap.startTask(
  { cwd: dir, sessionId: 'p' },
  "sh -c 'while true; do echo flooder-xxxxxxxxxxxxxxxxxxxxxx; done'",
);
await sleep(2500);
const s5 = regCap.snapshot(t5);
ok(
  'cap kill with notice written into the output file',
  s5.status === 'failed' &&
    (s5.error ?? '').includes('Output exceeded cap of') &&
    readFileSync(t5.outputAbsPath, 'utf8').includes('Output exceeded cap of'),
);

// 6. detached survival across a genuine parent exit + adoption + stop
process.env.BG_TEST_DIR = dir;
const spawner = spawnSync('npx', ['tsx', 'harness/posix-spawner.ts'], {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf8',
  timeout: 120_000,
});
if (spawner.stdout === undefined || spawner.stdout.trim().length === 0) {
  console.error('spawner failed:', spawner.stderr);
  process.exit(1);
}
const spawnIds = JSON.parse(spawner.stdout.trim()) as {
  a: string;
  b: string;
  aPid: number;
  bPid: number;
};
ok(
  'spawner exit left detached children alive',
  pidCount(spawnIds.aPid) === 1 && pidCount(spawnIds.bPid) === 1,
);

// adopt from the dead activation's dir
const regB = mk();
const adopted = await regB.reconcileTasksFromDisk();
ok('new activation adopts the orphaned records', adopted === 2);

// 6a. externally killed orphan: no marker (group kill, as any external owner
// must use — the recorded pgid is the kill authority on POSIX)
void spawnSync('sh', [
  '-c',
  `kill -TERM -${spawnIds.aPid} 2>/dev/null; sleep 1; kill -KILL -${spawnIds.aPid} 2>/dev/null`,
]);
await sleep(1500);
const orphan = regB.resolveTask(spawnIds.a);
if (
  !(
    orphan.status === 'failed' &&
    (orphan.error ?? '').includes('without writing a completion marker')
  )
) {
  console.log('orphan-diag:', orphan.status, orphan.error, 'pid', spawnIds.aPid);
}
ok(
  'externally killed orphan → failed without completion marker',
  orphan.status === 'failed' &&
    (orphan.error ?? '').includes('without writing a completion marker'),
);

// 6b. adoptee stopped via the new activation's group kill
await regB.stopTask(regB.resolveTask(spawnIds.b), 'user');
const killedTask = regB.resolveTask(spawnIds.b);
ok(
  'adoptee stopped via group signal + notification delivered',
  killedTask.status === 'killed' &&
    pidCount(spawnIds.bPid) === 0 &&
    notes.some((n) => n.includes(`<task-id>${spawnIds.b}</task-id>`)),
);

for (const [name, pass] of check) console.log(pass ? '  PASS' : '  FAIL', name);
console.log(check.every(([, pass]) => pass) ? 'ALL PASS' : 'FAILURES PRESENT');
process.exit(check.every(([, pass]) => pass) ? 0 : 1);
