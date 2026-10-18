/** Companion spawner for posix-matrix.ts: starts two tasks and exits while they run. */
import { mkdirSync } from 'node:fs';
import { BackgroundTaskRegistry } from '../src/core/registry.js';

const dir = process.env.BG_TEST_DIR ?? process.cwd();
mkdirSync(dir, { recursive: true });
const reg = new BackgroundTaskRegistry({
  tasksDir: dir,
  pollIntervalMs: 250,
  sendCompletionNotification: () => {},
});
const a = await reg.startTask({ cwd: dir, sessionId: 's' }, 'sh -c "sleep 125; echo later-a"');
const b = await reg.startTask({ cwd: dir, sessionId: 's' }, 'sh -c "sleep 125; echo later-b"');
process.stdout.write(JSON.stringify({ a: a.id, b: b.id, aPid: a.pid, bPid: b.pid, dir }));
process.exit(0);
