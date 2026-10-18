/**
 * Shared helpers for the background-task registry test suite.
 *
 * Every helper is platform-aware: the suite runs against the platform it is
 * executed on (POSIX group-kill machinery on Linux/macOS, WMI-created tasks
 * with taskkill tree ownership on Windows).
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskRegistryOptions,
} from '../src/core/registry.js';

export const IS_WIN = process.platform === 'win32';

export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A command that stays alive without a wrapper terminal for N seconds. */
export function sleeperCommand(seconds: number, tag: string): string {
  if (IS_WIN) {
    // waitfor rejects anything but A-Z, 0-9 in signal names.
    return `waitfor /t ${seconds} ${tag.toUpperCase().replace(/[^a-z0-9]/gi, 'x')}`;
  }
  return `sh -c "sleep ${seconds}; echo ${tag}"`;
}

/** 'true' while a pid exists, 'false' once gone. */
export function pidAlive(pid: number): boolean {
  const probe = IS_WIN
    ? spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Measure-Object).Count`,
        ],
        {
          encoding: 'utf8',
          timeout: 15_000,
        },
      )
    : spawnSync('sh', ['-c', `kill -0 ${pid} 2>/dev/null && echo 1 || echo 0`], {
        encoding: 'utf8',
      });
  return (probe.stdout ?? '0').trim().endsWith('1');
}

/**
 * Kills an orphaned task tree as any external owner must:
 * the recorded process group on POSIX, taskkill /T /F on Windows.
 */
export function killOrphanTree(pid: number): void {
  if (IS_WIN) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 15_000 });
    return;
  }
  // TERM to prompt a clean exit, then KILL; both target the whole group.
  spawnSync('sh', [
    '-c',
    `kill -TERM -${pid} 2>/dev/null; sleep 1; kill -KILL -${pid} 2>/dev/null`,
  ]);
}

/** Some checks converge asynchronously; failing to settle within the ceiling fails the test. */
export async function awaitSettled(
  registry: BackgroundTaskRegistry,
  task: { id: string },
  timeoutMs: number = 20_000,
): Promise<{ status: string; error?: string; exitCode?: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = registry.snapshot(registry.resolveTask(task.id));
    if (snapshot.status !== 'running') {
      return snapshot;
    }
    if (Date.now() > deadline) {
      throw new Error(`Task ${task.id} still running after ${String(timeoutMs)}ms`);
    }
    await sleep(200);
  }
}

/** A registry with a short poll interval and note capture for assertions. */
export function makeRegistry(
  tasksDir: string,
  options: Partial<BackgroundTaskRegistryOptions> = {},
): { registry: BackgroundTaskRegistry; notes: string[] } {
  const notes: string[] = [];
  const registry = new BackgroundTaskRegistry({
    tasksDir,
    pollIntervalMs: 250,
    sendCompletionNotification: (message) => {
      notes.push(message.content);
    },
    ...options,
  });
  return { registry, notes };
}

/** Launches the standalone spawner process: it starts tasks and exits while they run. */
export function runSpawner(
  tasksDir: string,
  cwd: string = process.cwd(),
): {
  a: string;
  b: string;
  aPid: number;
  bPid: number;
} {
  // On Windows a bare npx/tsx spawn cannot resolve .cmd shims: go through cmd.
  const spawnerEnv = {
    ...process.env,
    BG_TEST_DIR: tasksDir,
    BG_SPAWNER_TAG: randomUUID().replace(/-/g, '').slice(0, 6),
  };
  const spawnOpts = { cwd, env: spawnerEnv, encoding: 'utf8', timeout: 120_000 } as const;
  const result = IS_WIN
    ? spawnSync('cmd', ['/d', '/s', '/c', 'npx tsx tests/spawner.ts'], spawnOpts)
    : spawnSync('npx', ['tsx', 'tests/spawner.ts'], spawnOpts);
  if (result.stdout === undefined || !result.stdout.trim().startsWith('{')) {
    throw new Error(
      `spawner failed: ${(result.error ?? undefined)?.message ?? ''} ${result.stderr ?? ''} (status ${String(result.status)})`,
    );
  }
  return JSON.parse(result.stdout.trim()) as { a: string; b: string; aPid: number; bPid: number };
}
