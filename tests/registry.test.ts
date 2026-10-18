/**
 * Platform test suite for the detached background-task registry.
 *
 * Run it with `npm test` on the platform whose behavior you want to verify:
 * - POSIX (Linux/macOS): own process group, wrapper exit marker, group-kill
 *   machinery.
 * - Windows: WMI-created processes, cmd runner with exit marker, taskkill /T /F
 *   tree ownership. Windows-only pieces skip on POSIX and vice versa.
 *
 * One suite, `node:test` runner, no new dependencies.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveShellPolicy } from '../src/core/common.js';
import {
  awaitSettled,
  IS_WIN,
  killOrphanTree,
  makeRegistry,
  pidAlive,
  runSpawner,
  sleeperCommand,
} from './test-utils.js';

const dir = join(mkdtempSync(join(tmpdir(), 'bg-registry-tests-')), 'tasks');
const ctx = { cwd: dir, sessionId: 'bg-test' };

test('shell policy resolves for this platform', () => {
  const policy = resolveShellPolicy();
  assert.equal(policy.policy, IS_WIN ? 'cmd' : 'inherit');
  assert.ok(!IS_WIN || policy.dialect === 'cmd');
});

test('completion: wrapper marker, exit code, notification and captured output', async () => {
  const { registry, notes } = makeRegistry(dir);
  const command = IS_WIN
    ? 'echo bgtest-completion& exit 0'
    : 'sh -c "echo bgtest-completion; exit 0"';
  const task = await registry.startTask(ctx, command);
  const snapshot = await awaitSettled(registry, task);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.exitCode, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? '', new RegExp(task.id));
  assert.ok(readFileSync(task.outputAbsPath, 'utf8').includes('bgtest-completion'));
});

test('failed exit code is read from the wrapper marker', async () => {
  const { registry } = makeRegistry(dir);
  const command = IS_WIN ? 'echo bgtest-failing& exit 3' : 'sh -c "echo bgtest-failing; exit 3"';
  const task = await registry.startTask(ctx, command);
  const snapshot = await awaitSettled(registry, task);
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.exitCode, 3);
});

test('special characters survive the shell wrapper', async () => {
  const { registry } = makeRegistry(dir);
  const command = IS_WIN
    ? 'echo (parens-1) and "quo ted" & echo done-flip & exit 0'
    : `echo '(parens-1)' && echo "quo ted" && echo done-flip && exit 0`;
  const task = await registry.startTask(ctx, command);
  const snapshot = await awaitSettled(registry, task);
  assert.equal(snapshot.status, 'completed');
  const output = readFileSync(task.outputAbsPath, 'utf8');
  assert.ok(output.includes('parens-1'), output);
  assert.ok(output.includes('quo ted'), output);
  assert.ok(output.includes('done-flip'), output);
});

test('timeout kill terminates the tree and reports "Timed out"', async () => {
  const { registry } = makeRegistry(dir);
  const task = await registry.startTask(ctx, sleeperCommand(125, 'timeoutsleeper'), {
    timeoutSeconds: 2,
  });
  const snapshot = await awaitSettled(registry, task, 15_000);
  assert.equal(snapshot.status, 'failed');
  assert.ok((snapshot.error ?? '').includes('Timed out after 2s'));
  if (task.pid === undefined) throw new Error('no pid recorded');
  assert.equal(pidAlive(task.pid), false);
});

test('output cap terminates the task and the notice lands in the output', async () => {
  const { registry } = makeRegistry(dir, { maxOutputBytes: 3000 });
  const command = IS_WIN
    ? 'for /l %%i in (1,1,9999999) do @echo flooder-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    : "sh -c 'while true; do echo flooder-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done'";
  const task = await registry.startTask(ctx, command);
  const snapshot = await awaitSettled(registry, task, 20_000);
  assert.equal(snapshot.status, 'failed');
  assert.ok((snapshot.error ?? '').includes('Output exceeded cap'));
  assert.ok(readFileSync(task.outputAbsPath, 'utf8').includes('Output exceeded cap'));
});

test('windows: runner script nests the command under cmd /s /c', {
  skip: IS_WIN ? false : 'windows-only',
}, async () => {
  const { registry } = makeRegistry(dir);
  const task = await registry.startTask(ctx, 'echo bgtest-nested& exit 0');
  // The runner exists (and must be read) while the task is running; completion sweeps it.
  assert.ok(task.runnerScriptFile !== undefined && existsSync(task.runnerScriptFile));
  assert.ok(readFileSync(task.runnerScriptFile ?? '', 'utf8').includes('cmd.exe" /d /s /c "'));
  assert.ok(readFileSync(task.runnerScriptFile ?? '', 'utf8').includes('echo bgtest-nested'));
  const snapshot = await awaitSettled(registry, task);
  assert.equal(snapshot.status, 'completed');
});

test('posix: group cleanup does not leave wrappers behind', {
  skip: !IS_WIN ? false : 'posix-only',
}, async () => {
  const { registry } = makeRegistry(dir);
  const task = await registry.startTask(ctx, sleeperCommand(125, 'posixsleeper'));
  await registry.stopTask(registry.resolveTask(task.id), 'user', 'posix cleanup test');
  assert.equal(registry.snapshot(registry.resolveTask(task.id)).status, 'killed');
});

test('detachment across a real parent exit, then adoption, external kill and deliberate stop', async () => {
  const { registry, notes } = makeRegistry(dir);
  const spawnIds = runSpawner(dir);

  // The spawner process has long exited; both tasks must still be running.
  assert.equal(pidAlive(spawnIds.aPid), true);
  assert.equal(pidAlive(spawnIds.bPid), true);
  assert.equal(await registry.reconcileTasksFromDisk(), 2);

  // 1: externally killed orphan -> failed, no completion marker.
  killOrphanTree(spawnIds.aPid);
  const orphan = await awaitSettled(registry, { id: spawnIds.a });
  assert.equal(orphan.status, 'failed');
  assert.ok((orphan.error ?? '').includes('without writing a completion marker'));

  // 2: adoptee stopped by its new owner -> killed + notification delivered.
  const adoptee = registry.resolveTask(spawnIds.b);
  await registry.stopTask(adoptee, 'user', 'Adoptee stopped by the new owner');
  assert.equal(adoptee.status, 'killed');
  assert.ok(notes.some((note) => note.includes(spawnIds.b)));
  assert.equal(pidAlive(spawnIds.bPid), false);

  // 3: everything terminal on disk -> nothing left to adopt.
  const nextGeneration = makeRegistry(dir);
  assert.equal(await nextGeneration.registry.reconcileTasksFromDisk(), 0);
});
