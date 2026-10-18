/**
 * Companion spawner for the registry test suite.
 *
 * It starts two long-running tasks through its own registry, writes the task
 * ids and pids to stdout, and exits while the tasks keep running. In the test
 * suite it simulates a crashed Pi activation: the surviving tasks on disk are
 * then adopted by the activation under test.
 *
 * Environment:
 * - BG_TEST_DIR: tasks directory to use (required)
 * - BG_SPAWNER_TAG: unique tag to keep concurrent runs apart (required)
 */
import { mkdirSync } from 'node:fs';
import { BackgroundTaskRegistry } from '../src/core/registry.js';
import { sleeperCommand } from './test-utils.js';

const dir = process.env.BG_TEST_DIR;
const tag = process.env.BG_SPAWNER_TAG;
if (dir === undefined || tag === undefined) {
  process.stderr.write('BG_TEST_DIR and BG_SPAWNER_TAG are required\n');
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const registry = new BackgroundTaskRegistry({
  tasksDir: dir,
  pollIntervalMs: 250,
  sendCompletionNotification: () => {},
});
const a = await registry.startTask({ cwd: dir, sessionId: 's' }, sleeperCommand(125, `spw${tag}a`));
const b = await registry.startTask({ cwd: dir, sessionId: 's' }, sleeperCommand(125, `spw${tag}b`));
process.stdout.write(JSON.stringify({ a: a.id, b: b.id, aPid: a.pid, bPid: b.pid }));
process.exit(0);
