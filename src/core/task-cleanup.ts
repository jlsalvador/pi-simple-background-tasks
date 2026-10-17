import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TERMINAL_TASK_STATUS_VALUES } from './common.js';

export type CleanupScope = 'one' | 'session' | 'all';

export interface CleanupDeleted {
  id: string;
  status: string;
  runDir: string;
}

export interface CleanupSkipped {
  id: string;
  status: string;
}

export interface CleanupSummary {
  scope: CleanupScope;
  deleted: CleanupDeleted[];
  skipped: CleanupSkipped[];
  notFound: string[];
}

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUS_VALUES);

async function listRunDirs(tasksDir: string): Promise<string[]> {
  try {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(tasksDir, entry.name));
  } catch {
    return [];
  }
}

async function listTaskIds(runDir: string): Promise<string[]> {
  try {
    const entries = await readdir(runDir);
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, name.length - 5));
  } catch {
    return [];
  }
}

async function readTaskStatus(jsonPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { status?: unknown };
    return typeof parsed.status === 'string' ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

async function deleteTaskFiles(runDir: string, id: string): Promise<void> {
  await rm(join(runDir, `${id}.json`), { force: true });
  await rm(join(runDir, `${id}.output`), { force: true });
}

async function removeEmptyRunDir(runDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(runDir);
  } catch {
    return;
  }
  if (entries.length > 0) return;
  try {
    await rm(runDir, { recursive: true });
  } catch {
    // Best effort: a directory that cannot be removed is harmless.
  }
}
// Delete the on-disk files (.json + .output) of finished tasks only.
// Running tasks are never touched; they are reported in `skipped`.
// The run directory is removed once it becomes empty.
export async function cleanupFinishedTasks(options: {
  tasksDir: string;
  sessionRunDir?: string;
  scope: CleanupScope;
  taskId?: string;
}): Promise<CleanupSummary> {
  const { tasksDir, sessionRunDir, scope, taskId } = options;
  const summary: CleanupSummary = { scope, deleted: [], skipped: [], notFound: [] };

  const consider = async (runDir: string, id: string): Promise<void> => {
    const status = await readTaskStatus(join(runDir, `${id}.json`));
    if (status === undefined) {
      summary.notFound.push(id);
      return;
    }
    if (!TERMINAL.has(status)) {
      summary.skipped.push({ id, status });
      return;
    }
    await deleteTaskFiles(runDir, id);
    await removeEmptyRunDir(runDir);
    summary.deleted.push({ id, status, runDir });
  };

  if (scope === 'one') {
    if (!taskId) {
      summary.notFound.push('taskId is required for scope "one"');
      return summary;
    }
    const matches: { runDir: string; id: string }[] = [];
    for (const runDir of await listRunDirs(tasksDir)) {
      for (const id of await listTaskIds(runDir)) {
        if (id === taskId || id.startsWith(taskId)) matches.push({ runDir, id });
      }
    }
    if (matches.length === 0) {
      summary.notFound.push(taskId);
      return summary;
    }
    if (matches.length > 1) {
      summary.notFound.push(`ambiguous taskId "${taskId}": ${matches.map((m) => m.id).join(', ')}`);
      return summary;
    }
    const only = matches[0];
    if (only) await consider(only.runDir, only.id);
    return summary;
  }

  if (scope === 'session') {
    if (!sessionRunDir) {
      summary.notFound.push('no tasks have been started in this session yet');
      return summary;
    }
    for (const id of await listTaskIds(sessionRunDir)) {
      await consider(sessionRunDir, id);
    }
    return summary;
  }

  for (const runDir of await listRunDirs(tasksDir)) {
    for (const id of await listTaskIds(runDir)) {
      await consider(runDir, id);
    }
  }
  return summary;
}
