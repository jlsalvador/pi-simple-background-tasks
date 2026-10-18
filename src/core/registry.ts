import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { formatSize } from '@earendil-works/pi-coding-agent';
import {
  type BgLogsDetails,
  type BgTask,
  type BgTaskSnapshot,
  boundedRead,
  deriveTaskNameFromCommand,
  escapeXml,
  formatDuration,
  type KillKind,
  normalizeTaskName,
  type ResolvedShellPolicy,
  resolveShellPolicy,
  type ShellPolicySnapshot,
  type StartTaskOptions,
  sanitizePathSegment,
  shellPolicySnapshot,
  snapshot,
  type TaskStatus,
  type TerminalPublicationAbandonReason,
  taskDisplayName,
} from './common.js';
import { defaultTasksDir } from './config.js';
import type { DetachedSpawnFn } from './detached-spawn.js';
import { exitMarkerPath, runnerScriptPath, spawnDetachedTask } from './detached-spawn.js';
import { BackgroundTaskExtensionServiceClosedError } from './extension-api.js';
import {
  type CleanupScope,
  type CleanupSummary,
  cleanupFinishedTasks as cleanupTasksOnDisk,
} from './task-cleanup.js';
import { writeJsonAtomic } from './task-durable.js';
import {
  runWindowsTaskkill,
  type TaskkillOutcome,
  type WindowsTaskkillOptions,
} from './windows-taskkill.js';

export const MAX_OUTPUT_BYTES = Number(process.env.PI_BG_MAX_OUTPUT_BYTES ?? 20 * 1024 * 1024);
export const KILL_GRACE_MS = 3000;
export const STOP_WAIT_MS = KILL_GRACE_MS + 1500;
export const MAX_RECENT_TASKS = 100;
export const TERMINAL_PUBLICATION_MAX_ATTEMPTS = 3;
export const TERMINAL_PUBLICATION_RETRY_MS = 100;
/** One poller for all tasks: markers, byte cap and timeouts are checked here. */
export const TASK_POLL_INTERVAL_MS = 1000;
const TERMINAL_PUBLICATION_DIAGNOSTIC_CHARS = 500;

export type TerminalPublicationClosureReason = Extract<
  TerminalPublicationAbandonReason,
  'registry_shutdown' | 'publisher_closed'
>;

type TerminalPublicationGateOutcome =
  | { readonly kind: 'released' }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'closed'; readonly reason: TerminalPublicationAbandonReason };

interface TerminalPublicationAbandonSignal {
  readonly promise: Promise<TerminalPublicationAbandonReason>;
  readonly resolve: (reason: TerminalPublicationAbandonReason) => void;
}

export class BackgroundTaskAdmissionClosedError extends Error {
  readonly code = 'pi_background_tasks_admission_closed';

  constructor(kind: string) {
    super(`Cannot start ${kind} after background tasks are shutting down`);
    this.name = 'BackgroundTaskAdmissionClosedError';
  }
}

interface PosixProcessGroupKillState {
  readonly groupId: number;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
  readonly deadlineAt: number;
  verificationTimer?: NodeJS.Timeout | undefined;
  forceAttempted: boolean;
  settled: boolean;
  failure?: Error | undefined;
  lastProbeError?: Error | undefined;
  failureListeners?: Array<(error: Error) => void> | undefined;
}

interface WindowsKillState {
  forcePromise?: Promise<void> | undefined;
  forceFailure?: Error | undefined;
  forceFailureListeners?: Array<(error: Error) => void> | undefined;
}

export interface BackgroundTaskContext {
  cwd: string;
  sessionId?: string;
}

export type BackgroundTaskSpawn = DetachedSpawnFn;

export interface BackgroundTaskRegistryOptions {
  sendCompletionNotification: CompletionNotificationSender;
  publishTerminal?: (task: BgTaskSnapshot) => void;
  spawn?: BackgroundTaskSpawn;
  killProcess?: KillProcessFn;
  killTree?: KillTreeFn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  shellPolicy?: ResolvedShellPolicy;
  tasksDir?: string | undefined;
  makeTaskId?: () => string;
  now?: () => number;
  maxOutputBytes?: number;
  maxRecentTasks?: number;
  killGraceMs?: number;
  stopWaitMs?: number;
  pollIntervalMs?: number;
  logger?: Pick<Console, 'error'>;
}

export type KillProcessFn = (pid: number, signal?: NodeJS.Signals | number) => boolean;
export type KillTreeFn = (pid: number, signal?: AbortSignal) => Promise<TaskkillOutcome>;

export type CompletionNotificationSender = (
  message: CompletionNotificationMessage,
  options: CompletionNotificationOptions,
) => void;

interface CompletionNotificationMessage {
  readonly customType: 'background-task-notification';
  readonly content: string;
  readonly display: boolean;
  readonly details: BgTaskSnapshot;
}

interface CompletionNotificationOptions {
  readonly deliverAs: 'followUp';
  readonly triggerTurn: boolean;
}

interface RuntimeDir {
  abs: string;
  display: string;
}

function defaultTaskId(): string {
  return `b${randomBytes(4).toString('hex')}`;
}

function noopOnChange(): void {}

/** Strictly serializable fields adopted from a previous run's metadata file. */
type PersistedTaskRecord = {
  status?: unknown;
  readonly command: string;
  readonly cwd: string;
  readonly startTime: number;
  readonly endTime?: number | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly pid?: number | undefined;
  readonly posixProcessGroupId?: number | undefined;
  readonly bytesWritten: number;
  readonly error?: string | undefined;
  readonly notified: boolean;
  readonly notifyOnCompletion: boolean;
  readonly triggerOnCompletion: boolean;
  readonly timeoutSeconds?: number | undefined;
  readonly shellPolicy?: ShellPolicySnapshot | undefined;
};

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BgTask>();
  private runtimeDir: RuntimeDir | undefined;
  private readonly tasksDir: string;
  private shuttingDown = false;
  private terminalPublicationClosed = false;
  private terminalPublicationCloseReason: TerminalPublicationClosureReason | undefined;
  private readonly terminalPublicationClosedSignal: Promise<TerminalPublicationClosureReason>;
  private resolveTerminalPublicationClosedSignal: (
    reason: TerminalPublicationClosureReason,
  ) => void = () => {};
  private readonly spawn: BackgroundTaskSpawn | undefined;
  private readonly killProcess: KillProcessFn;
  private readonly killTree: KillTreeFn;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private shellPolicy: ResolvedShellPolicy | undefined;
  private readonly shellPolicyEnv: NodeJS.ProcessEnv | undefined;
  private readonly makeTaskIdFn: () => string;
  private readonly now: () => number;
  private readonly maxOutputBytes: number;
  private readonly maxRecentTasks: number;
  private readonly killGraceMs: number;
  private readonly stopWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly logger: Pick<Console, 'error'>;
  private readonly sendCompletionNotification: CompletionNotificationSender;
  private readonly publishTerminalSnapshot: (task: BgTaskSnapshot) => void;
  private readonly posixProcessGroupKillStates = new WeakMap<BgTask, PosixProcessGroupKillState>();
  private readonly windowsKillStates = new WeakMap<BgTask, WindowsKillState>();
  private readonly terminalPublicationAbandonSignals = new WeakMap<
    BgTask,
    TerminalPublicationAbandonSignal
  >();
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(options: BackgroundTaskRegistryOptions) {
    this.terminalPublicationClosedSignal = new Promise((resolve) => {
      this.resolveTerminalPublicationClosedSignal = resolve;
    });
    this.spawn = options.spawn;
    this.killProcess = options.killProcess ?? process.kill.bind(process);
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.shellPolicy = options.shellPolicy;
    this.tasksDir = options.tasksDir ?? defaultTasksDir();
    this.shellPolicyEnv = options.shellPolicy === undefined ? { ...this.env } : undefined;
    const taskkillEnv = this.env;
    this.killTree =
      options.killTree ??
      ((pid, signal) => {
        const taskkillOptions: WindowsTaskkillOptions =
          signal === undefined ? { env: taskkillEnv } : { env: taskkillEnv, signal };
        return runWindowsTaskkill(pid, taskkillOptions);
      });
    this.makeTaskIdFn = options.makeTaskId ?? defaultTaskId;
    this.now = options.now ?? Date.now;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.maxRecentTasks = options.maxRecentTasks ?? MAX_RECENT_TASKS;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? TASK_POLL_INTERVAL_MS;
    this.logger = options.logger ?? console;
    this.sendCompletionNotification = options.sendCompletionNotification;
    this.publishTerminalSnapshot = options.publishTerminal ?? noopOnChange;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  private resolvedShellPolicy(): ResolvedShellPolicy {
    const existing = this.shellPolicy;
    if (existing !== undefined) return existing;
    const resolved = resolveShellPolicy(
      this.platform,
      this.shellPolicyEnv ?? this.env,
      process.cwd(),
    );
    this.shellPolicy = resolved;
    return resolved;
  }

  setShuttingDown(value: boolean): void {
    if (value) {
      this.shuttingDown = true;
      this.stopPoller();
      this.closeTerminalPublication('registry_shutdown');
      return;
    }
    // Publication closure belongs to one extension activation and is one-way.
    // A reloaded Pi creates a fresh registry; an old registry must not be
    // reopened by a late lifecycle continuation.
    if (!this.terminalPublicationClosed) this.shuttingDown = false;
  }

  closeTerminalPublication(reason: TerminalPublicationClosureReason): void {
    if (!this.terminalPublicationClosed) {
      this.terminalPublicationClosed = true;
      this.terminalPublicationCloseReason = reason;
      this.resolveTerminalPublicationClosedSignal(reason);
    }
    const effectiveReason = this.terminalPublicationCloseReason ?? reason;
    for (const task of this.tasks.values()) {
      if (task.terminalPublicationState === 'pending' && task.terminalEmitInFlight === true) {
        // A synchronous listener can close the service while emit() is still on
        // the stack. Dispose queued work now, but let the emitter's return/throw
        // settle the in-flight attempt exactly once.
        if (task.terminalPublishRetryHandle !== undefined) {
          clearTimeout(task.terminalPublishRetryHandle);
          task.terminalPublishRetryHandle = undefined;
        }
        task.terminalPublicationGate = undefined;
        continue;
      }
      const shouldLog =
        task.terminalPublicationState === 'pending' &&
        task.status !== 'running' &&
        (task.terminalPublishAttempts > 0 ||
          task.terminalPublishRetryHandle !== undefined ||
          task.terminalPublicationGate !== undefined);
      this.abandonTerminalPublication(task, effectiveReason, undefined, shouldLog);
    }
    this.pruneOldTasks();
  }

  allTasks(): BgTask[] {
    return [...this.tasks.values()];
  }

  snapshot(task: BgTask): BgTaskSnapshot {
    return snapshot(task);
  }

  // Delete the on-disk files of finished tasks in the given scope. Running
  // tasks are left untouched and reported. Current-run tasks are also dropped
  // from the in-memory registry so /jobs stays consistent.
  async cleanupFinishedTasks(scope: CleanupScope, taskId?: string): Promise<CleanupSummary> {
    const summary = await cleanupTasksOnDisk({
      tasksDir: this.tasksDir,
      sessionRunDir: this.runtimeDir?.abs,
      scope,
      taskId,
    });
    for (const deleted of summary.deleted) {
      this.tasks.delete(deleted.id);
    }
    return summary;
  }

  async ensureRuntimeDir(ctx: BackgroundTaskContext): Promise<RuntimeDir> {
    if (this.runtimeDir) return this.runtimeDir;
    const sessionId = sanitizePathSegment(ctx.sessionId ?? `session-${String(process.pid)}`);
    const runId = `${sessionId}-${String(process.pid)}`;
    const runtimeDirAbs = join(this.tasksDir, runId);
    await mkdir(runtimeDirAbs, { recursive: true });
    this.runtimeDir = { abs: runtimeDirAbs, display: runtimeDirAbs };
    return this.runtimeDir;
  }

  /**
   * The single launch path. The child is spawned detached from the very first
   * step and the extension never owns it at runtime: ownership facts (pid, pgid,
   * marker path) are recorded on disk, so a same-process /reload or a full Pi
   * restart cannot lose a running task. Node exit is impossible for detached
   * children to report back, so the wrapper's exit marker is the terminal truth.
   */
  async startTask(
    ctx: BackgroundTaskContext,
    command: string,
    options: StartTaskOptions = {},
  ): Promise<BgTask> {
    if (this.shuttingDown) throw new BackgroundTaskAdmissionClosedError('a background task');
    const normalizedCommand = command.trim();
    if (!normalizedCommand) throw new Error('Background command is empty');

    const dir = await this.ensureRuntimeDir(ctx);
    const id = this.makeTaskIdFn();
    const outputAbsPath = join(dir.abs, `${id}.output`);
    const metadataAbsPath = join(dir.abs, `${id}.json`);
    const shellPolicy = this.resolvedShellPolicy();
    const outputPath = join(dir.display, `${id}.output`);
    const timeoutSeconds =
      typeof options.timeoutSeconds === 'number' &&
      Number.isFinite(options.timeoutSeconds) &&
      options.timeoutSeconds > 0
        ? Math.floor(options.timeoutSeconds)
        : undefined;
    const taskName =
      normalizeTaskName(options.name) ??
      normalizeTaskName(options.description) ??
      deriveTaskNameFromCommand(normalizedCommand);
    const trimmedDescription = options.description?.trim();
    const description =
      trimmedDescription && trimmedDescription.length > 0 ? trimmedDescription : undefined;

    const task: BgTask = {
      id,
      name: taskName,
      command: normalizedCommand,
      description,
      status: 'running',
      outputPath,
      outputAbsPath,
      metadataAbsPath,
      cwd: ctx.cwd,
      startTime: this.now(),
      exitCode: undefined,
      pid: undefined,
      posixProcessGroupId: undefined,
      bytesWritten: 0,
      notified: false,
      notifyOnCompletion: options.notifyOnCompletion ?? true,
      triggerOnCompletion: options.triggerOnCompletion ?? false,
      timeoutSeconds,
      terminalPublished: false,
      terminalPublicationState: 'pending',
      terminalPublishAttempts: 0,
      terminalPublicationGate: options.terminalPublicationGate,
      shellPolicy: shellPolicySnapshot(shellPolicy),
      exitMarkerAbsPath: exitMarkerPath(dir.abs, id),
      waiters: [],
    };
    this.tasks.set(id, task);
    // Persist before spawning so a crash mid-launch leaves an adoptable record.
    await this.writeMetadata(task);

    try {
      const result = await spawnDetachedTask({
        id,
        taskDirAbs: dir.abs,
        command: normalizedCommand,
        policy: shellPolicy,
        cwd: ctx.cwd,
        env: this.env,
        ...(this.spawn === undefined ? {} : { spawn: this.spawn }),
        platform: this.platform,
      });
      task.pid = result.pid;
      task.posixProcessGroupId = result.posixProcessGroupId;
      if (result.posixProcessGroupId !== undefined) {
        task.ownedPosixProcessGroupId = result.posixProcessGroupId;
      }
      task.exitMarkerAbsPath = result.exitMarkerFile;
      task.exitMarkerTrusted = result.exitMarkerTrusted;
      task.runnerScriptFile = result.runnerScriptFile;
      await this.writeMetadata(task);
      this.ensurePoller();
      return task;
    } catch (launchError) {
      const message = launchError instanceof Error ? launchError.message : String(launchError);
      if (task.pid === undefined) {
        // Nothing was launched; sweep every artifact so no half-task remains.
        task.finalized = true;
        task.status = 'failed';
        task.error = message;
        this.tasks.delete(id);
        const runner = join(dir.abs, `${id}.runner.cmd`);
        await Promise.allSettled([
          rm(outputAbsPath, { force: true }),
          rm(metadataAbsPath, { force: true }),
          rm(runner, { force: true }),
        ]);
        throw launchError;
      }
      await this.appendNotice(task, `\n[background task launch error: ${message}]\n`);
      await this.finalizeTask(task, 'failed', null, undefined, message);
      throw new Error(`Failed to start background task: ${message}`);
    }
  }

  resolveTask(idOrPrefix: string): BgTask {
    const id = idOrPrefix.trim();
    if (!id) throw new Error('Task ID is required');
    const exact = this.tasks.get(id);
    if (exact) return exact;
    const matches = [...this.tasks.values()].filter((task) => task.id.startsWith(id));
    const onlyMatch = matches[0];
    if (matches.length === 1 && onlyMatch) return onlyMatch;
    if (matches.length > 1)
      throw new Error(
        `Ambiguous task ID prefix "${id}": ${matches.map((task) => task.id).join(', ')}`,
      );
    throw new Error(`Unknown background task ID: ${id}`);
  }

  async stopTask(task: BgTask, kind: KillKind, reason?: string): Promise<BgTask> {
    if (task.status !== 'running') {
      throw new Error(`Task ${task.id} is ${task.status}, not running`);
    }
    const stopWaitMs = this.stopWaitMs;
    if (
      this.platform !== 'win32' &&
      task.posixProcessGroupSignalAuthorityReleased === true &&
      this.posixProcessGroupKillStates.get(task) === undefined
    ) {
      const finalized = await this.waitForEnd(task, stopWaitMs);
      if (!finalized) {
        throw new Error(
          `Task ${task.id} did not finish terminalization within ${formatDuration(stopWaitMs)} after its process group signal authority was released`,
        );
      }
      return task;
    }
    task.killKind = kind;
    if (reason) task.error = reason;
    this.requestKill(task, 'SIGTERM');
    const stopped =
      this.platform === 'win32'
        ? await this.waitForEndOrWindowsForceFailure(task, stopWaitMs)
        : await this.waitForEndOrPosixForceFailure(task, stopWaitMs);
    const posixForceFailure = this.posixProcessGroupKillStates.get(task)?.failure;
    if (posixForceFailure !== undefined) throw posixForceFailure;
    const windowsForceFailure = this.windowsKillStates.get(task)?.forceFailure;
    if (windowsForceFailure !== undefined) throw windowsForceFailure;
    if (!stopped) {
      throw new Error(
        `Task ${task.id} did not exit within ${formatDuration(stopWaitMs)} after cancellation`,
      );
    }
    return task;
  }

  async stopAllRunning(
    kind: KillKind,
    reason?: string,
  ): Promise<{ stopped: number; failures: string[] }> {
    const running = this.allTasks().filter((task) => task.status === 'running');
    const failures: string[] = [];
    let stopped = 0;
    await Promise.all(
      running.map(async (task) => {
        try {
          await this.stopTask(task, kind, reason);
          stopped++;
        } catch (error) {
          failures.push(
            `${taskDisplayName(task)} (${task.id}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    return { stopped, failures };
  }

  async getTaskLogs(
    task: BgTask,
    maxBytes: number,
    tail: boolean,
  ): Promise<{ text: string; details: BgLogsDetails }> {
    if (!existsSync(task.outputAbsPath)) {
      throw new Error(`Output file does not exist for ${task.id}: ${task.outputPath}`);
    }
    const read = await boundedRead(task.outputAbsPath, maxBytes, tail);
    const direction = tail ? 'tail' : 'head';
    let text = read.content.length > 0 ? read.content : '(no output yet)';
    if (read.truncated) {
      const omitted = read.totalBytes - read.bytesRead;
      const notice = `\n\n[Showing ${direction} ${formatSize(read.bytesRead)} of ${formatSize(read.totalBytes)}; ${formatSize(omitted)} omitted. Full output: ${task.outputPath}]`;
      text = tail ? `${notice}\n\n${text}` : `${text}${notice}`;
    } else {
      text += `\n\n[Full output: ${task.outputPath}]`;
    }
    return {
      text,
      details: {
        task: snapshot(task),
        path: task.outputPath,
        bytesRead: read.bytesRead,
        truncated: read.truncated,
        tail,
      },
    };
  }

  // ---------- adoption: running tasks recorded on disk by an earlier activation ----------

  /**
   * Scan the tasks folder for persisted records still marked `running` and
   * either adopt them (process group alive), finalize them from their exit
   * marker, or mark them failed (process gone without a marker). Runs on every
   * activation, which is exactly what makes /reload and Pi restarts safe.
   */
  async reconcileTasksFromDisk(): Promise<number> {
    const runDirs = await this.listRunDirs();
    let adopted = 0;
    for (const runDir of runDirs) {
      const ids = await this.listTaskIds(runDir);
      for (const id of ids) {
        if (this.tasks.has(id)) continue;
        const metadataPath = join(runDir, `${id}.json`);
        let record: PersistedTaskRecord | undefined;
        try {
          record = JSON.parse(await readFile(metadataPath, 'utf8')) as PersistedTaskRecord;
        } catch {
          continue;
        }
        const task = this.taskFromMetadata(id, runDir, metadataPath, record);
        if (task === undefined) continue;
        // Only records whose durable status is `running` are adopted. A task
        // that already reached terminal state while another activation owned
        // it stays on disk untouched: re-importing it would replicate its
        // notification instead of merely observing it.
        if (record.status !== 'running') continue;
        this.tasks.set(task.id, task);
        adopted++;

        const marker =
          task.exitMarkerTrusted === true ? await this.readExitMarker(task) : undefined;
        if (marker !== undefined) {
          void this.finalizeTask(task, ...this.terminalFromMarker(task, marker));
          continue;
        }
        if (this.probeProcessAlive(task)) {
          this.ensurePoller();
          continue;
        }
        void this.finalizeTask(
          task,
          'failed',
          null,
          undefined,
          'Task process is gone and no completion marker was written; the task ran under an earlier Pi activation',
        );
      }
    }
    return adopted;
  }

  private async listRunDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.tasksDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.tasksDir, entry.name));
    } catch {
      return [];
    }
  }

  private async listTaskIds(runDir: string): Promise<string[]> {
    try {
      const entries = await readdir(runDir);
      return entries
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, name.length - '.json'.length));
    } catch {
      return [];
    }
  }

  private taskFromMetadata(
    id: string,
    runDir: string,
    metadataAbsPath: string,
    record: PersistedTaskRecord,
  ): BgTask | undefined {
    const command = typeof record.command === 'string' ? record.command : undefined;
    const cwd = typeof record.cwd === 'string' ? record.cwd : undefined;
    const startTime = typeof record.startTime === 'number' ? record.startTime : undefined;
    if (command === undefined || cwd === undefined || startTime === undefined) return undefined;
    const dialect = record.shellPolicy?.dialect;
    // An unclassified user shell ran unwrapped and never writes a marker.
    const exitMarkerTrusted = dialect !== 'user-non-posix';
    return {
      id,
      name: deriveTaskNameFromCommand(command),
      command,
      description: undefined,
      status: 'running',
      outputPath: join(runDir, `${id}.output`),
      outputAbsPath: join(runDir, `${id}.output`),
      metadataAbsPath,
      cwd,
      startTime,
      exitCode: undefined,
      pid: typeof record.pid === 'number' ? record.pid : undefined,
      posixProcessGroupId:
        typeof record.posixProcessGroupId === 'number' ? record.posixProcessGroupId : undefined,
      ownedPosixProcessGroupId:
        this.platform !== 'win32' && typeof record.posixProcessGroupId === 'number'
          ? record.posixProcessGroupId
          : undefined,
      bytesWritten: typeof record.bytesWritten === 'number' ? record.bytesWritten : 0,
      notified: record.notified === true,
      notifyOnCompletion: record.notifyOnCompletion !== false,
      triggerOnCompletion: record.triggerOnCompletion === true,
      timeoutSeconds: typeof record.timeoutSeconds === 'number' ? record.timeoutSeconds : undefined,
      terminalPublished: false,
      terminalPublicationState: 'pending',
      terminalPublishAttempts: 0,
      shellPolicy: record.shellPolicy,
      exitMarkerAbsPath: exitMarkerPath(runDir, id),
      exitMarkerTrusted,
      runnerScriptFile:
        dialect === 'cmd' && record.status === 'running' ? runnerScriptPath(runDir, id) : undefined,
      waiters: [],
    };
  }

  private async readExitMarker(task: BgTask): Promise<string | undefined> {
    if (task.exitMarkerAbsPath === undefined) return undefined;
    try {
      return (await readFile(task.exitMarkerAbsPath, 'utf8')).trim();
    } catch {
      return undefined;
    }
  }

  /** Terminal status derived from a wrapper exit marker. */
  private terminalFromMarker(
    task: BgTask,
    markerValue: string,
  ): [
    status: TaskStatus,
    exitCode: number | null,
    signal: string | null,
    error: string | undefined,
  ] {
    if (!/^\d+$/u.test(markerValue)) {
      return ['failed', null, null, 'Completion marker did not contain a valid exit code'];
    }
    const exitCode = Number(markerValue);
    if (task.capExceeded === true) {
      return ['failed', exitCode, null, task.error ?? 'Output cap exceeded'];
    }
    if (task.killKind === 'user' || task.killKind === 'shutdown') {
      return ['killed', exitCode, null, task.error];
    }
    if (task.killKind === 'timeout') {
      return ['failed', exitCode, null, task.error ?? 'Timed out'];
    }
    if (exitCode === 0) return ['completed', exitCode, null, undefined];
    return ['failed', exitCode, null, `Exited with code ${String(exitCode)}`];
  }

  /** Group liveness on POSIX; pid existence on Windows. Never sends a signal. */
  private probeProcessAlive(task: BgTask): boolean {
    if (this.platform !== 'win32') {
      const group = task.ownedPosixProcessGroupId;
      if (group === undefined) return false;
      try {
        return this.killProcess(-group, 0) !== false;
      } catch (error) {
        if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
          return false;
        }
        // Probe errors other than ESRCH are inconclusive: stay a poller tick.
        return true;
      }
    }
    if (task.pid === undefined) return false;
    try {
      return this.killProcess(task.pid, 0) !== false;
    } catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
        return false;
      }
      return true;
    }
  }

  // ---------- one poller: completion markers, byte cap, timeouts, exits ----------

  private ensurePoller(): void {
    if (this.shuttingDown || this.pollTimer !== undefined) return;
    this.pollTimer = setInterval(() => this.tick(), this.pollIntervalMs);
    this.pollTimer.unref();
  }

  private stopPoller(): void {
    if (this.pollTimer === undefined) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private tick(): void {
    if (this.shuttingDown) {
      this.stopPoller();
      return;
    }
    let hasRunning = false;
    for (const task of [...this.tasks.values()]) {
      if (task.status !== 'running' || task.finalized === true) continue;
      hasRunning = true;
      if (task.pollInFlight === true) continue;
      task.pollInFlight = true;
      void this.pollTask(task)
        .catch((error: unknown) => {
          this.logger.error(
            `[background-tasks] poll failed for ${task.id}:`,
            error instanceof Error ? error : new Error(String(error)),
          );
        })
        .finally(() => {
          task.pollInFlight = false;
        });
    }
    if (!hasRunning) this.stopPoller();
  }

  private async pollTask(task: BgTask): Promise<void> {
    if (task.status !== 'running' || task.finalized === true) return;

    // 1. output size bookkeeping: kept current for snapshots on every tick.
    let outputSize: number | undefined;
    try {
      outputSize = (await stat(task.outputAbsPath)).size;
      task.bytesWritten = outputSize;
    } catch {
      // stat failures are transient (or the file is gone); the next tick retries.
    }

    // 2. completion marker: terminal truth.
    const marker = task.exitMarkerTrusted === true ? await this.readExitMarker(task) : undefined;
    if (marker !== undefined) {
      const [status, exitCode, signal, error] = this.terminalFromMarker(task, marker);
      await this.finalizeTask(task, status, exitCode, signal, error);
      return;
    }

    // 3. cap enforcement on a still-running task
    if (task.capExceeded !== true && outputSize !== undefined && outputSize > this.maxOutputBytes) {
      task.capExceeded = true;
      task.killKind = 'output_cap';
      task.error = `Output exceeded cap of ${formatSize(this.maxOutputBytes)}; terminating task`;
      const notice = `\n\n[background task error: ${task.error}]\n`;
      if (this.platform === 'win32') {
        // The child's own redirection locks the output file until the tree is
        // gone, so termination must release it before the notice can land.
        this.startTerminate(task);
        await this.appendNotice(task, notice);
        return;
      }
      await this.appendNotice(task, notice);
      this.startTerminate(task);
      return;
    }

    // 4. timeout enforcement
    if (
      task.killSignalSent !== true &&
      task.timeoutSeconds !== undefined &&
      this.now() - task.startTime >= task.timeoutSeconds * 1000
    ) {
      task.killKind = 'timeout';
      task.error = `Timed out after ${String(task.timeoutSeconds)}s`;
      const notice = `\n[background task timeout: ${task.error}]\n`;
      if (this.platform === 'win32') {
        this.startTerminate(task);
        await this.appendNotice(task, notice);
        return;
      }
      await this.appendNotice(task, notice);
      this.startTerminate(task);
      return;
    }

    // 5. exited without a marker (wrapper killed externally, or no wrapper)
    if (!this.probeProcessAlive(task)) {
      const [status, error] = this.terminalFromKindWithoutMarker(task);
      await this.finalizeTask(task, status, null, undefined, error);
    }
  }

  private terminalFromKindWithoutMarker(task: BgTask): [TaskStatus, string | undefined] {
    if (task.capExceeded === true || task.killKind === 'output_cap') {
      return ['failed', task.error ?? 'Output cap exceeded'];
    }
    if (task.killKind === 'timeout') {
      return ['failed', task.error ?? 'Timed out'];
    }
    if (task.killKind === 'user' || task.killKind === 'shutdown') {
      return ['killed', task.error];
    }
    return [
      'failed',
      'Process exited without writing a completion marker; its exit code is unknown',
    ];
  }

  /** Request the one TREE stop; errors surface on the poller or stopTask path. */
  private startTerminate(task: BgTask): void {
    try {
      this.requestKill(task, 'SIGTERM');
    } catch (error) {
      task.error = `${task.error}; kill failed: ${BackgroundTaskRegistry.errorMessage(error)}`;
      void this.finalizeTask(task, 'failed', null, undefined, task.error);
    }
  }

  /** Persist an internally generated notice (spawn/timeout/cap) verbatim. */
  private async appendNotice(task: BgTask, text: string): Promise<void> {
    if (!text) return;
    // On Windows the child's own `1>` redirection holds the output file with a
    // lock that rejects a concurrent append until the tree is gone; a bounded
    // retry lets the notice land after the termination release.
    const attempts = this.platform === 'win32' ? 6 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await appendFile(task.outputAbsPath, text, 'utf8');
        task.bytesWritten += Buffer.byteLength(text, 'utf8');
        return;
      } catch (error) {
        const busy =
          this.platform === 'win32' &&
          error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'EBUSY';
        if (!busy || attempt === attempts) {
          this.logger.error(
            `[background-tasks] failed to append notice for ${task.id}:`,
            error instanceof Error ? error : new Error(String(error)),
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400).unref?.());
      }
    }
  }

  // ---------- POSIX process-group kill machinery ----------

  private beginPosixProcessGroupKill(task: BgTask, armGrace: boolean): PosixProcessGroupKillState {
    const existing = this.posixProcessGroupKillStates.get(task);
    if (existing !== undefined) return existing;
    if (task.posixProcessGroupSignalAuthorityReleased === true) {
      throw new Error(`Task ${task.id} has released its POSIX process-group signal authority`);
    }
    if (task.ownedPosixProcessGroupId === undefined) {
      throw new Error(`Task ${task.id} has no owned POSIX process group`);
    }
    const groupId = task.ownedPosixProcessGroupId;

    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const reserveMs = Math.min(25, Math.max(1, Math.floor(this.stopWaitMs / 4)));
    const ownershipMs = Math.max(1, this.stopWaitMs - reserveMs);
    const state: PosixProcessGroupKillState = {
      groupId,
      completion,
      resolveCompletion,
      deadlineAt: Date.now() + ownershipMs,
      forceAttempted: false,
      settled: false,
    };
    this.posixProcessGroupKillStates.set(task, state);

    if (armGrace) {
      task.killEscalationTimer = setTimeout(
        () => {
          task.killEscalationTimer = undefined;
          this.forceOwnedPosixProcessGroup(task, state);
        },
        Math.min(this.killGraceMs, ownershipMs),
      );
      // Stays referenced on purpose: a departed leader must not let the host
      // exit before its owned group is verified gone.
    }
    return state;
  }

  private finishPosixProcessGroupKill(
    task: BgTask,
    state: PosixProcessGroupKillState,
    releaseOwnership: boolean,
  ): void {
    if (state.settled) return;
    state.settled = true;
    this.clearKillEscalationTimer(task);
    if (state.verificationTimer !== undefined) {
      clearTimeout(state.verificationTimer);
      state.verificationTimer = undefined;
    }
    task.posixProcessGroupSignalAuthorityReleased = true;
    if (releaseOwnership && task.ownedPosixProcessGroupId === state.groupId) {
      delete task.ownedPosixProcessGroupId;
    }
    state.resolveCompletion();
    const failure = state.failure;
    const listeners = state.failureListeners;
    if (listeners !== undefined) {
      delete state.failureListeners;
      if (failure !== undefined) {
        for (const listener of listeners) listener(failure);
      }
    }
  }

  private observeOwnedPosixProcessGroupGone(
    task: BgTask,
    state: PosixProcessGroupKillState,
  ): boolean {
    if (state.settled) return state.failure === undefined;
    try {
      const exists = this.killProcess(-state.groupId, 0);
      state.lastProbeError = exists
        ? undefined
        : new Error(`process-group probe for ${String(state.groupId)} returned false`);
      return false;
    } catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
        this.finishPosixProcessGroupKill(task, state, true);
        return true;
      }
      state.lastProbeError =
        error instanceof Error ? error : new Error(BackgroundTaskRegistry.errorMessage(error));
      return false;
    }
  }

  private recordPosixProcessGroupForceFailure(
    task: BgTask,
    state: PosixProcessGroupKillState,
    error: Error,
  ): void {
    if (state.settled) return;
    state.failure = error;
    this.finishPosixProcessGroupKill(task, state, false);
    task.error = BackgroundTaskRegistry.appendTaskError(task.error, error.message);
    void this.appendNotice(task, `\n[background task POSIX termination: ${error.message}]\n`);
    void this.writeMetadata(task).catch((metadataError: unknown) => {
      this.logger.error(
        `[background-tasks] failed to write POSIX process-group failure metadata for ${task.id}:`,
        metadataError,
      );
    });
  }

  private schedulePosixProcessGroupVerification(
    task: BgTask,
    state: PosixProcessGroupKillState,
  ): void {
    if (state.settled) return;
    const remainingMs = state.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      const probeDetail =
        state.lastProbeError === undefined
          ? ''
          : `; last group probe failed: ${state.lastProbeError.message}`;
      this.recordPosixProcessGroupForceFailure(
        task,
        state,
        new Error(
          `POSIX process group ${String(state.groupId)} remained present after SIGKILL${probeDetail}. Descendant processes may have leaked.`,
        ),
      );
      return;
    }
    state.verificationTimer = setTimeout(
      () => {
        state.verificationTimer = undefined;
        if (this.observeOwnedPosixProcessGroupGone(task, state)) return;
        this.schedulePosixProcessGroupVerification(task, state);
      },
      Math.min(10, remainingMs),
    );
  }

  private forceOwnedPosixProcessGroup(task: BgTask, state: PosixProcessGroupKillState): void {
    if (state.settled || state.forceAttempted) return;
    state.forceAttempted = true;
    this.clearKillEscalationTimer(task);
    if (this.observeOwnedPosixProcessGroupGone(task, state)) return;

    try {
      const forced = this.killProcess(-state.groupId, 'SIGKILL');
      if (!forced) {
        this.recordPosixProcessGroupForceFailure(
          task,
          state,
          new Error(
            `POSIX process-group SIGKILL returned false for task ${task.id} group ${String(state.groupId)}. Descendant processes may have leaked.`,
          ),
        );
        return;
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
        this.finishPosixProcessGroupKill(task, state, true);
        return;
      }
      this.recordPosixProcessGroupForceFailure(
        task,
        state,
        new Error(
          `POSIX process-group SIGKILL failed for task ${task.id} group ${String(state.groupId)}: ${BackgroundTaskRegistry.errorMessage(error)}. Descendant processes may have leaked.`,
        ),
      );
      return;
    }

    if (this.observeOwnedPosixProcessGroupGone(task, state)) return;
    this.schedulePosixProcessGroupVerification(task, state);
  }

  private requestPosixKill(task: BgTask, signal: NodeJS.Signals): void {
    const state = this.beginPosixProcessGroupKill(task, signal !== 'SIGKILL');
    if (signal === 'SIGKILL') {
      task.killSignalSent = true;
      this.forceOwnedPosixProcessGroup(task, state);
      return;
    }
    if (task.killSignalSent) return;
    task.killSignalSent = true;

    const errors: string[] = [];
    let killed = false;
    try {
      killed = this.killProcess(-state.groupId, signal);
      if (!killed) errors.push(`process group ${signal} returned false`);
    } catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
        this.finishPosixProcessGroupKill(task, state, true);
      } else {
        errors.push(`process group kill failed: ${BackgroundTaskRegistry.errorMessage(error)}`);
      }
    }

    if (!killed) {
      // If TERM reached no target, waiting out grace has no benefit. Keep the
      // same owner but attempt its one force phase immediately.
      if (!state.settled) this.forceOwnedPosixProcessGroup(task, state);
      throw new Error(`Could not kill task ${task.id}: ${errors.join('; ')}`);
    }
  }

  private async awaitPosixProcessGroupBeforeTerminal(task: BgTask): Promise<Error | undefined> {
    if (this.platform === 'win32') return undefined;
    const state = this.posixProcessGroupKillStates.get(task);
    if (state === undefined) {
      // No tree stop won the race before terminalization. Release signal
      // authority synchronously so a concurrent late stop waits for terminal
      // settlement instead of targeting a potentially reused group id.
      task.posixProcessGroupSignalAuthorityReleased = true;
      delete task.ownedPosixProcessGroupId;
      return undefined;
    }
    this.observeOwnedPosixProcessGroupGone(task, state);
    await state.completion;
    return state.failure;
  }

  private waitForEndOrPosixForceFailure(task: BgTask, timeoutMs: number): Promise<boolean> {
    const state = this.posixProcessGroupKillStates.get(task);
    if (state === undefined) return this.waitForEnd(task, timeoutMs);
    if (state.failure !== undefined) return Promise.reject(state.failure);
    if (task.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        const waiterIndex = task.waiters.indexOf(done);
        if (waiterIndex >= 0) task.waiters.splice(waiterIndex, 1);
        const listeners = state.failureListeners;
        if (listeners !== undefined) {
          const listenerIndex = listeners.indexOf(failed);
          if (listenerIndex >= 0) listeners.splice(listenerIndex, 1);
          if (listeners.length === 0) delete state.failureListeners;
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const done = () => {
        cleanup();
        resolve(true);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      task.waiters.push(done);
      if (state.failureListeners === undefined) state.failureListeners = [];
      state.failureListeners.push(failed);
    });
  }

  // ---------- Windows taskkill tree machinery ----------

  private waitForEnd(task: BgTask, timeoutMs: number): Promise<boolean> {
    if (task.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const idx = task.waiters.indexOf(done);
        if (idx >= 0) task.waiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      task.waiters.push(done);
    });
  }

  private waitForEndOrWindowsForceFailure(task: BgTask, timeoutMs: number): Promise<boolean> {
    const state = this.getWindowsKillState(task);
    if (state.forceFailure !== undefined) return Promise.reject(state.forceFailure);
    if (task.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        const waiterIndex = task.waiters.indexOf(done);
        if (waiterIndex >= 0) task.waiters.splice(waiterIndex, 1);
        const listeners = state.forceFailureListeners;
        if (listeners !== undefined) {
          const listenerIndex = listeners.indexOf(failed);
          if (listenerIndex >= 0) listeners.splice(listenerIndex, 1);
          if (listeners.length === 0) delete state.forceFailureListeners;
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const done = () => {
        cleanup();
        resolve(true);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      task.waiters.push(done);
      if (state.forceFailureListeners === undefined) state.forceFailureListeners = [];
      state.forceFailureListeners.push(failed);
    });
  }

  private async awaitWindowsForceBeforeTerminal(task: BgTask): Promise<Error | undefined> {
    const state = this.windowsKillStates.get(task);
    if (state === undefined) return undefined;
    const forcePromise = state.forcePromise;
    if (forcePromise === undefined) return state.forceFailure;
    try {
      await forcePromise;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return state.forceFailure;
  }

  private getWindowsKillState(task: BgTask): WindowsKillState {
    let state = this.windowsKillStates.get(task);
    if (state === undefined) {
      state = {};
      this.windowsKillStates.set(task, state);
    }
    return state;
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static appendTaskError(existing: string | undefined, next: string): string {
    if (existing === undefined || existing.length === 0) return next;
    if (existing.includes(next)) return existing;
    return `${existing}; ${next}`;
  }

  private static describeTaskkillOutcome(outcome: TaskkillOutcome): string {
    const exitCode = outcome.exitCode === null ? 'null' : String(outcome.exitCode);
    const signal = outcome.signal === null ? 'null' : outcome.signal;
    const stdout = outcome.stdout.length > 0 ? ` stdout=${JSON.stringify(outcome.stdout)}` : '';
    const stderr = outcome.stderr.length > 0 ? ` stderr=${JSON.stringify(outcome.stderr)}` : '';
    const stdoutTruncated = outcome.stdoutTruncated ? ' stdout_truncated=true' : '';
    const stderrTruncated = outcome.stderrTruncated ? ' stderr_truncated=true' : '';
    return `exit=${exitCode} signal=${signal}${stdout}${stderr}${stdoutTruncated}${stderrTruncated}`;
  }

  private isWindowsTaskkillTerminalRace(task: BgTask): boolean {
    return task.status !== 'running' || task.finalized === true;
  }

  private clearKillEscalationTimer(task: BgTask): void {
    if (task.killEscalationTimer !== undefined) {
      clearTimeout(task.killEscalationTimer);
      task.killEscalationTimer = undefined;
    }
  }

  private recordWindowsTaskkillNotice(task: BgTask, message: string): void {
    void this.appendNotice(task, `\n[background task Windows termination: ${message}]\n`).catch(
      () => undefined,
    );
  }

  private makeWindowsForceFailure(task: BgTask, pid: number, detail: string): Error {
    return new Error(
      `Windows taskkill /T /F tree termination failed for task ${task.id} pid ${String(pid)}: ${detail}. Descendant processes may have leaked.`,
    );
  }

  private recordWindowsForceFailure(task: BgTask, error: Error): void {
    const state = this.getWindowsKillState(task);
    state.forceFailure = error;
    task.error = BackgroundTaskRegistry.appendTaskError(task.error, error.message);
    this.recordWindowsTaskkillNotice(task, error.message);
    void this.writeMetadata(task).catch((metadataError: unknown) => {
      this.logger.error(
        `[background-tasks] failed to write Windows taskkill force-failure metadata for ${task.id}:`,
        metadataError,
      );
    });
    const listeners = state.forceFailureListeners;
    if (listeners !== undefined) {
      delete state.forceFailureListeners;
      for (const listener of listeners) listener(error);
    }
  }

  private evaluateWindowsTaskkillOutcome(
    task: BgTask,
    pid: number,
    outcome: TaskkillOutcome,
  ): Error | undefined {
    if (outcome.exitCode === 0) return undefined;
    const detail = BackgroundTaskRegistry.describeTaskkillOutcome(outcome);
    if (this.isWindowsTaskkillTerminalRace(task)) {
      this.recordWindowsTaskkillNotice(
        task,
        `taskkill finished after the task became terminal for pid ${String(pid)} (${detail}); treating as a terminal race`,
      );
      return undefined;
    }
    if (outcome.exitCode === 128) {
      // With a single force kill, 128 means taskkill could not find the tree:
      // an already-exited race.
      this.recordWindowsTaskkillNotice(
        task,
        `taskkill reported process not found for pid ${String(pid)} (${detail}); treating as an already-exited race`,
      );
      return undefined;
    }
    return this.makeWindowsForceFailure(task, pid, detail);
  }

  private startWindowsTaskkill(task: BgTask, pid: number): Promise<void> {
    const state = this.getWindowsKillState(task);
    if (state.forcePromise !== undefined) return state.forcePromise;

    let resolveForce: (() => void) | undefined;
    let rejectForce: ((error: unknown) => void) | undefined;
    const forcePromise = new Promise<void>((resolve, reject) => {
      resolveForce = resolve;
      rejectForce = reject;
    });
    if (resolveForce === undefined || rejectForce === undefined) {
      throw new Error('Windows force termination promise could not be initialized');
    }
    const resolveForceReady = resolveForce;
    const rejectForceReady = rejectForce;
    state.forcePromise = forcePromise;
    void forcePromise.catch((error: unknown) => {
      this.logger.error(
        `[background-tasks] Windows tree termination failed for ${task.id}:`,
        error,
      );
    });

    this.clearKillEscalationTimer(task);

    const afterTreeStop = (): void => {
      // Terminalize without waiting for the next poll tick.
      if (task.status === 'running' && task.finalized !== true) {
        void this.pollTask(task);
      }
    };

    let launched: Promise<TaskkillOutcome>;
    try {
      launched = this.killTree(pid);
    } catch (error) {
      const failure = this.makeWindowsForceFailure(
        task,
        pid,
        `helper failed to start: ${BackgroundTaskRegistry.errorMessage(error)}`,
      );
      delete state.forcePromise;
      this.recordWindowsForceFailure(task, failure);
      rejectForceReady(failure);
      throw failure;
    }

    launched.then(
      (outcome) => {
        const failure = this.evaluateWindowsTaskkillOutcome(task, pid, outcome);
        if (failure !== undefined) {
          this.recordWindowsForceFailure(task, failure);
          rejectForceReady(failure);
          return;
        }
        resolveForceReady();
        afterTreeStop();
      },
      (error: unknown) => {
        if (this.isWindowsTaskkillTerminalRace(task)) {
          this.recordWindowsTaskkillNotice(
            task,
            `taskkill rejected after the task became terminal for pid ${String(pid)} (${BackgroundTaskRegistry.errorMessage(error)}); treating as a terminal race`,
          );
          resolveForceReady();
          return;
        }
        const failure = this.makeWindowsForceFailure(
          task,
          pid,
          BackgroundTaskRegistry.errorMessage(error),
        );
        this.recordWindowsForceFailure(task, failure);
        rejectForceReady(failure);
      },
    );

    return forcePromise;
  }

  private requestKill(task: BgTask, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (task.status !== 'running') {
      throw new Error(`Task ${task.id} is ${task.status}, not running`);
    }
    if (task.killSignalSent) return;

    if (this.platform === 'win32') {
      if (!task.pid) throw new Error(`Task ${task.id} has no process id`);
      // One Windows kill: `taskkill /T /F`. Console applications do not honor
      // window-close termination, so there is nothing for a graceful phase to
      // contain and no escalation ladder to arm.
      task.killSignalSent = true;
      this.startWindowsTaskkill(task, task.pid);
      return;
    }

    this.requestPosixKill(task, signal);
  }

  // ---------- metadata ----------

  private async writeMetadata(task: BgTask): Promise<void> {
    await this.writeMetadataSnapshot(task, snapshot(task));
  }

  private async writeMetadataSnapshot(task: BgTask, value: BgTaskSnapshot): Promise<void> {
    const write = async () => {
      await writeJsonAtomic(task.metadataAbsPath, value);
    };
    const previous = task.metadataWriteChain ?? Promise.resolve();
    const next = previous.then(write, write);
    task.metadataWriteChain = next.catch(() => undefined);
    await next;
  }

  // ---------- terminal publication and notification ----------

  private terminalPublicationAbandonSignal(task: BgTask): TerminalPublicationAbandonSignal {
    const existing = this.terminalPublicationAbandonSignals.get(task);
    if (existing !== undefined) return existing;
    let resolveSignal: (reason: TerminalPublicationAbandonReason) => void = () => {};
    const promise = new Promise<TerminalPublicationAbandonReason>((resolve) => {
      resolveSignal = resolve;
    });
    const signal = { promise, resolve: resolveSignal };
    this.terminalPublicationAbandonSignals.set(task, signal);
    return signal;
  }

  private publishTerminal(task: BgTask): void {
    if (this.tasks.get(task.id) !== task) return;
    if (task.terminalPublicationState !== 'pending' || task.terminalPublishInFlight) return;
    if (this.terminalPublicationClosed) {
      this.abandonTerminalPublication(
        task,
        this.terminalPublicationCloseReason ?? 'registry_shutdown',
      );
      return;
    }
    task.terminalPublishInFlight = true;
    if (task.terminalPublicationGate === undefined) {
      this.tryPublishTerminalNow(task);
      return;
    }
    void this.publishTerminalWhenReady(task);
  }

  private async publishTerminalWhenReady(task: BgTask): Promise<void> {
    const outcome = await this.waitForTerminalPublicationGate(task);
    if (this.tasks.get(task.id) !== task) {
      task.terminalPublishInFlight = false;
      return;
    }
    if (outcome.kind === 'closed') {
      this.abandonTerminalPublication(task, outcome.reason);
      return;
    }
    if (outcome.kind === 'rejected') {
      this.abandonTerminalPublication(task, 'gate_rejected', outcome.error);
      return;
    }
    if (this.terminalPublicationClosed || task.terminalPublicationState !== 'pending') {
      this.abandonTerminalPublication(
        task,
        this.terminalPublicationCloseReason ?? 'registry_shutdown',
      );
      return;
    }
    this.tryPublishTerminalNow(task);
  }

  private async waitForTerminalPublicationGate(
    task: BgTask,
  ): Promise<TerminalPublicationGateOutcome> {
    if (this.terminalPublicationClosed) {
      return {
        kind: 'closed',
        reason: this.terminalPublicationCloseReason ?? 'registry_shutdown',
      };
    }
    if (task.terminalPublicationState === 'abandoned') {
      if (task.terminalPublicationAbandonReason === 'gate_rejected') {
        return { kind: 'rejected', error: new Error('terminal publication gate rejected') };
      }
      return {
        kind: 'closed',
        reason: task.terminalPublicationAbandonReason ?? 'registry_shutdown',
      };
    }
    const gate = task.terminalPublicationGate;
    if (gate === undefined) return { kind: 'released' };

    const gateOutcome: Promise<TerminalPublicationGateOutcome> = gate.then(
      () => ({ kind: 'released' }),
      (error: unknown) => ({ kind: 'rejected', error }),
    );
    const closureOutcome: Promise<TerminalPublicationGateOutcome> =
      this.terminalPublicationClosedSignal.then((reason) => ({ kind: 'closed', reason }));
    const abandonmentOutcome: Promise<TerminalPublicationGateOutcome> =
      this.terminalPublicationAbandonSignal(task).promise.then((reason) => ({
        kind: 'closed',
        reason,
      }));
    const outcome = await Promise.race([gateOutcome, closureOutcome, abandonmentOutcome]);

    if (this.terminalPublicationClosed) {
      return {
        kind: 'closed',
        reason: this.terminalPublicationCloseReason ?? 'registry_shutdown',
      };
    }
    return outcome;
  }

  private tryPublishTerminalNow(task: BgTask): void {
    if (this.tasks.get(task.id) !== task) {
      task.terminalPublishInFlight = false;
      return;
    }
    if (task.terminalPublicationState !== 'pending') {
      task.terminalPublishInFlight = false;
      return;
    }
    if (this.terminalPublicationClosed) {
      task.terminalPublishInFlight = false;
      this.abandonTerminalPublication(
        task,
        this.terminalPublicationCloseReason ?? 'registry_shutdown',
      );
      this.pruneOldTasks();
      return;
    }

    task.terminalPublishAttempts += 1;
    task.terminalEmitInFlight = true;
    let emitFailed = false;
    let emitError: unknown;
    try {
      this.publishTerminalSnapshot(snapshot(task));
    } catch (error) {
      emitFailed = true;
      emitError = error;
    }
    task.terminalEmitInFlight = false;
    task.terminalPublishInFlight = false;

    if (emitFailed) {
      this.handleTerminalPublishFailure(task, emitError);
    } else {
      this.markTerminalPublicationDelivered(task);
    }
    this.pruneOldTasks();
  }

  private markTerminalPublicationDelivered(task: BgTask): void {
    if (task.terminalPublishRetryHandle !== undefined) {
      clearTimeout(task.terminalPublishRetryHandle);
      task.terminalPublishRetryHandle = undefined;
    }
    task.terminalPublicationGate = undefined;
    task.terminalEmitInFlight = false;
    task.terminalPublishInFlight = false;
    task.terminalPublicationState = 'delivered';
    delete task.terminalPublicationAbandonReason;
    task.terminalPublished = true;
  }

  private abandonTerminalPublication(
    task: BgTask,
    reason: TerminalPublicationAbandonReason,
    error?: unknown,
    log = true,
  ): void {
    if (task.terminalPublishRetryHandle !== undefined) {
      clearTimeout(task.terminalPublishRetryHandle);
      task.terminalPublishRetryHandle = undefined;
    }
    task.terminalPublicationGate = undefined;
    if (task.terminalEmitInFlight !== true) task.terminalPublishInFlight = false;
    if (task.terminalPublicationState === 'delivered') return;
    if (task.terminalPublicationState === 'abandoned') return;

    task.terminalPublicationState = 'abandoned';
    task.terminalPublicationAbandonReason = reason;
    task.terminalPublished = false;
    this.terminalPublicationAbandonSignal(task).resolve(reason);
    if (log) {
      const detail = error === undefined ? '' : `: ${this.terminalPublicationError(error)}`;
      this.logger.error(
        `[background-tasks] terminal publication abandoned for ${task.id} (${reason}) after ${String(task.terminalPublishAttempts)}/${String(TERMINAL_PUBLICATION_MAX_ATTEMPTS)} emit attempts${detail}`,
      );
    }
  }

  private terminalPublicationError(error: unknown): string {
    const compact = BackgroundTaskRegistry.errorMessage(error).replace(/\s+/gu, ' ').trim();
    if (compact.length <= TERMINAL_PUBLICATION_DIAGNOSTIC_CHARS) return compact;
    return `${compact.slice(0, TERMINAL_PUBLICATION_DIAGNOSTIC_CHARS - 1)}…`;
  }

  private handleTerminalPublishFailure(task: BgTask, error: unknown): void {
    task.terminalPublishInFlight = false;
    if (task.terminalPublicationState !== 'pending') return;
    if (error instanceof BackgroundTaskExtensionServiceClosedError) {
      this.closeTerminalPublication('publisher_closed');
      return;
    }
    if (this.terminalPublicationClosed) {
      this.abandonTerminalPublication(
        task,
        this.terminalPublicationCloseReason ?? 'registry_shutdown',
        error,
      );
      this.pruneOldTasks();
      return;
    }
    if (task.terminalPublishAttempts >= TERMINAL_PUBLICATION_MAX_ATTEMPTS) {
      this.abandonTerminalPublication(task, 'retry_exhausted', error);
      this.pruneOldTasks();
      return;
    }

    this.logger.error(
      `[background-tasks] terminal publication failed for ${task.id} (attempt ${String(task.terminalPublishAttempts)}/${String(TERMINAL_PUBLICATION_MAX_ATTEMPTS)}; retrying): ${this.terminalPublicationError(error)}`,
    );
    if (task.terminalPublishRetryHandle !== undefined) return;
    task.terminalPublishRetryHandle = setTimeout(() => {
      task.terminalPublishRetryHandle = undefined;
      if (
        this.terminalPublicationClosed ||
        task.terminalPublicationState !== 'pending' ||
        this.tasks.get(task.id) !== task
      ) {
        return;
      }
      this.publishTerminal(task);
    }, TERMINAL_PUBLICATION_RETRY_MS);
    task.terminalPublishRetryHandle.unref();
  }

  private notifyCompletion(task: BgTask): void {
    if (!task.notifyOnCompletion || task.notified || this.shuttingDown) return;
    task.notified = true;
    const exit =
      task.exitCode === undefined ? '' : `\n  <exit-code>${String(task.exitCode)}</exit-code>`;
    const error = task.error ? `\n  <error>${escapeXml(task.error)}</error>` : '';
    const taskName = taskDisplayName(task);
    const guidance =
      'Terminal state and output metadata are durable. Do not call bg_status to reconfirm; use bg_logs only if output is needed.';
    const content = [
      '<background-task-notification>',
      `  <task-id>${task.id}</task-id>`,
      `  <task-name>${escapeXml(taskName)}</task-name>`,
      `  <status>${task.status}</status>`,
      exit,
      error,
      `  <output-file>${escapeXml(task.outputPath)}</output-file>`,
      `  <summary>${escapeXml(`Background task ${JSON.stringify(taskName)} ${task.status}`)}</summary>`,
      `  <guidance>${escapeXml(guidance)}</guidance>`,
      '</background-task-notification>',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      this.sendCompletionNotification(
        {
          customType: 'background-task-notification',
          content,
          display: true,
          details: snapshot(task),
        },
        { deliverAs: 'followUp', triggerTurn: task.triggerOnCompletion },
      );
    } catch (error) {
      task.notified = false;
      throw new Error(
        `Failed to send background task notification for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async finalizeTask(
    task: BgTask,
    status: TaskStatus,
    exitCode: number | null,
    signal?: string | null,
    error?: string,
  ): Promise<void> {
    if (task.finalized) return;
    task.finalized = true;
    this.clearKillEscalationTimer(task);
    let finalStatus = status;
    let finalError = error;
    const posixForceFailure = await this.awaitPosixProcessGroupBeforeTerminal(task);
    if (posixForceFailure !== undefined) {
      finalStatus = 'failed';
      finalError = BackgroundTaskRegistry.appendTaskError(finalError, posixForceFailure.message);
    }
    const windowsForceFailure = await this.awaitWindowsForceBeforeTerminal(task);
    if (windowsForceFailure !== undefined) {
      finalStatus = 'failed';
      finalError = BackgroundTaskRegistry.appendTaskError(finalError, windowsForceFailure.message);
    }
    task.exitCode = exitCode;
    task.signal = signal ?? null;

    // The runner script is disposable once the child is terminal.
    if (task.runnerScriptFile !== undefined) {
      const runner = task.runnerScriptFile;
      await rm(runner, { force: true }).catch(() => undefined);
      task.runnerScriptFile = undefined;
    }

    task.endTime = this.now();
    if (finalError) task.error = finalError;
    try {
      await this.writeMetadataSnapshot(task, { ...snapshot(task), status: finalStatus });
      task.status = finalStatus;
    } catch (metadataError) {
      finalStatus = 'failed';
      task.status = 'failed';
      task.error = `Terminal metadata write failed: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`;
      this.logger.error(
        `[background-tasks] failed to write metadata for ${task.id}:`,
        metadataError,
      );
      await this.writeMetadata(task).catch((retryError: unknown) => {
        this.logger.error(
          `[background-tasks] failed to write failed terminal metadata for ${task.id}:`,
          retryError,
        );
      });
    }

    for (const waiter of task.waiters.splice(0)) waiter();
    this.publishTerminal(task);
    const deliveryGate = await this.waitForTerminalPublicationGate(task);
    if (deliveryGate.kind === 'rejected') {
      this.logger.error(
        `[background-tasks] completion delivery gate failed for ${task.id}: ${this.terminalPublicationError(deliveryGate.error)}`,
      );
    } else {
      // EventBus disposal abandons only EventBus publication. Notification truth
      // remains independent; notifyCompletion itself suppresses session shutdown.
      try {
        this.notifyCompletion(task);
      } catch (notificationError) {
        this.logger.error(
          `[background-tasks] notification failed for ${task.id}:`,
          notificationError,
        );
      }
    }
    try {
      await this.writeMetadata(task);
    } catch (metadataError) {
      this.logger.error(
        `[background-tasks] failed to update notification metadata for ${task.id}:`,
        metadataError,
      );
    }
    this.pruneOldTasks();
  }

  private pruneOldTasks(): void {
    if (this.tasks.size <= this.maxRecentTasks) return;
    const removable = [...this.tasks.values()]
      .filter((task) => task.status !== 'running' && task.terminalEmitInFlight !== true)
      .sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime));
    while (this.tasks.size > this.maxRecentTasks && removable.length > 0) {
      const task = removable.shift();
      if (task === undefined) continue;
      if (task.terminalPublicationState === 'pending') {
        this.abandonTerminalPublication(task, 'retention_limit');
      }
      this.tasks.delete(task.id);
    }
  }
}
