/**
 * Windows matrix spawner: simulates a Pi activation that starts two long
 * sleeper tasks and then dies (crash/restart). The detached children must
 * keep running; a later activation adopts them from disk.
 *
 * Launched by win-matrix.ts with BG_TEST_DIR pointing at the shared tasks dir.
 */
import { BackgroundTaskRegistry } from '../src/core/registry.js';

const tasksDir = process.env.BG_TEST_DIR;
if (tasksDir === undefined || tasksDir.length === 0) {
  console.error('BG_TEST_DIR is not set');
  process.exit(2);
}

const reg = new BackgroundTaskRegistry({
  tasksDir,
  pollIntervalMs: 10_000,
  sendCompletionNotification: () => undefined,
});
const ctx = { cwd: tasksDir, sessionId: 'spawner' };
const a = await reg.startTask(ctx, 'waitfor /t 120 ORPHANSIGA');
const b = await reg.startTask(ctx, 'waitfor /t 120 ORPHANSIGB');
console.log(JSON.stringify({ a: a.id, b: b.id, aPid: a.pid, bPid: b.pid, dir: tasksDir }));
await new Promise((resolve) => setTimeout(resolve, 800));
process.exit(0);
