import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { formatSize } from '@earendil-works/pi-coding-agent';
import {
  type KeyId,
  type OverlayHandle,
  type OverlayOptions,
  Text,
  type TUI,
} from '@earendil-works/pi-tui';
import { type Static, Type } from 'typebox';
import {
  type BgKillDetails,
  type BgLogsDetails,
  type BgRunDetails,
  type BgStatusDetails,
  type BgTask,
  type BgTaskSnapshot,
  DEFAULT_LOG_BYTES,
  deriveCompletionDeliveryGuidance,
  deriveTaskNameFromCommand,
  formatSnapshotList,
  MAX_LOG_BYTES,
  normalizeMaxBytes,
  normalizeTaskName,
  parseBgCommandArgs,
  type StartTaskOptions,
  taskDisplayName,
  truncateChars,
} from './core/common.js';
import { resolveBackgroundTasksConfig } from './core/config.js';
import {
  type BackgroundTaskExtensionService,
  installBackgroundTaskExtensionApi,
} from './core/extension-api.js';
import { LazyModule, SynchronousActivationCloseFence } from './core/lazy-module.js';
import { type BackgroundTaskContext, BackgroundTaskRegistry } from './core/registry.js';
import { createShellPolicyGuidanceHandler, initializeShellPolicy } from './core/shell-policy.js';
import type { CleanupScope, CleanupSummary } from './core/task-cleanup.js';
import {
  type BackgroundTaskForUi,
  type BackgroundTasksManager,
  FULLSCREEN_MARGINS,
  type TaskManagerOptions,
} from './ui/background-tasks-manager.js';

/**
 * Project-local Pi background task manager.
 *
 * Scope:
 * - Explicit background shell jobs only: /bg and bg_run spawn commands directly.
 * - No Ctrl+B support for backgrounding an already-running built-in bash tool.
 * - Tasks always survive /reload and Pi restarts: every task spawns detached,
 *   its ownership facts live in its on-disk metadata, and each activation
 *   adopts still-running records from disk. Pi session shutdown kills all
 *   running tasks, so exit with care.
 * - No flag negotiates any of this: there is exactly one launch path.
 */

const COMMAND_PREVIEW_CHARS = 90;

function textContent(text: string) {
  return [{ type: 'text' as const, text }];
}

interface TextToolResult {
  content?: ReadonlyArray<{ type: string; text?: string }>;
}

interface BgToolArgumentRecord {
  readonly command?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly timeoutSeconds?: unknown;
  readonly notifyOnCompletion?: unknown;
  readonly triggerOnCompletion?: unknown;
  /** Legacy argument, silently ignored: survival is now unconditional. */
  readonly surviveReload?: unknown;
}

function optionalTrimmed(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const BgRunParams = Type.Object({
  name: Type.String({
    description: 'Short human-readable task name. Required; use 2-6 words, not the raw command.',
  }),
  command: Type.String({ description: 'Shell command to start in the background' }),
  description: Type.Optional(
    Type.String({ description: 'Optional longer human-readable context for the task' }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({ description: 'Optional timeout; task is failed and killed when exceeded' }),
  ),
  notifyOnCompletion: Type.Optional(
    Type.Boolean({
      description:
        'Whether to deliver the durable terminal notification. Default: true; disable only when deliberately taking over completion monitoring.',
    }),
  ),
  triggerOnCompletion: Type.Optional(
    Type.Boolean({
      description:
        'Whether that notification should automatically trigger a follow-up agent turn. Default: true for bg_run; requires notifyOnCompletion.',
    }),
  ),
});

const BgStatusParams = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description:
        'Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned.',
    }),
  ),
});

const BgLogsParams = Type.Object({
  taskId: Type.String({ description: 'Task ID or unambiguous prefix' }),
  maxBytes: Type.Optional(
    Type.Number({
      description: `Maximum bytes to return, capped at ${formatSize(MAX_LOG_BYTES)}. Default: ${formatSize(DEFAULT_LOG_BYTES)}.`,
    }),
  ),
  tail: Type.Optional(
    Type.Boolean({
      description: 'Read the tail of the log when true, head when false. Default: true.',
    }),
  ),
});

const BgKillParams = Type.Object({
  taskId: Type.String({ description: 'Task ID or unambiguous prefix to stop' }),
});

const BgCleanParams = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description:
        'Delete this single task (by ID or unambiguous prefix). When set, scope is ignored.',
    }),
  ),
  scope: Type.Optional(
    Type.Union([Type.Literal('session'), Type.Literal('all')], {
      description:
        "Which finished tasks to delete when taskId is omitted: 'session' (this session, default) or 'all' (the entire tasks folder).",
    }),
  ),
});

type BgRunParamsValue = Static<typeof BgRunParams>;

function renderPlainResult(result: TextToolResult, options: ToolRenderResultOptions, theme: Theme) {
  void options;
  void theme;
  const text =
    result.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n') ?? '';
  return new Text(text, 0, 0);
}

interface BgCleanDetails {
  scope: CleanupScope;
  deleted: { id: string; status: string }[];
  skipped: { id: string; status: string }[];
  notFound: string[];
}

function formatCleanMessage(summary: CleanupSummary): string {
  const scopeLabel =
    summary.scope === 'one'
      ? 'the specified task'
      : summary.scope === 'session'
        ? 'this session'
        : 'the entire tasks folder';
  const plural = (n: number): string => (n === 1 ? '' : 's');
  const parts = [
    `Cleaned ${summary.deleted.length} finished task${plural(summary.deleted.length)} in ${scopeLabel}.`,
  ];
  if (summary.skipped.length > 0) {
    parts.push(
      `Skipped ${summary.skipped.length} running task${plural(summary.skipped.length)}: ${summary.skipped
        .map((s) => s.id)
        .join(', ')}.`,
    );
  }
  if (summary.notFound.length > 0) {
    parts.push(`Not found: ${summary.notFound.join(', ')}.`);
  }
  return parts.join(' ');
}

export default async function backgroundTasksExtension(pi: ExtensionAPI): Promise<void> {
  const config = resolveBackgroundTasksConfig(process.cwd());
  const shellPolicy = initializeShellPolicy();
  pi.on('before_agent_start', createShellPolicyGuidanceHandler(shellPolicy));
  let disposed = false;
  let shutdownReason = 'shutdown';
  const activationCloseFence = new SynchronousActivationCloseFence();
  const taskManagerLoader = new LazyModule(() => import('./ui/background-tasks-manager.js'));

  const registryContext = (ctx: ExtensionContext): BackgroundTaskContext => ({
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
  });

  const registry = new BackgroundTaskRegistry({
    sendCompletionNotification: (message, options) => {
      pi.sendMessage(message, options);
    },
    publishTerminal: (task) => {
      eventService.publishTerminal(task);
    },
    shellPolicy,
    tasksDir: config.tasksDir,
  });
  const eventService: BackgroundTaskExtensionService = installBackgroundTaskExtensionApi({
    events: pi.events,
    registry,
  });

  const beginSessionShutdown = (): void => {
    if (disposed) return;
    disposed = true;
    registry.setShuttingDown(true);
    eventService.close();
  };
  // Join the one synchronous all-lane barrier: every lazy lane closes on the
  // same call stack before Pi can await any later cleanup handler.
  activationCloseFence.add(() => {
    beginSessionShutdown();
  });
  activationCloseFence.add(() => {
    taskManagerLoader.close();
  });
  pi.on('session_shutdown', (event) => {
    shutdownReason = event.reason;
    activationCloseFence.close();
  });

  pi.on('session_start', async (_event, ctx) => {
    // A Pi reload binds a fresh extension instance. Adoptions run before any
    // task can start so notifications continue for tasks running across the
    // reload, and the poller takes over ownership detection from disk records.
    if (disposed) return;
    registry.setShuttingDown(false);
    await registry.ensureRuntimeDir(registryContext(ctx));
    if (disposed) return;
    try {
      await registry.reconcileTasksFromDisk();
    } catch (error) {
      console.error(
        '[background-tasks] failed to reconcile background tasks from disk:',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });

  async function startTask(
    ctx: ExtensionContext,
    command: string,
    options: StartTaskOptions = {},
  ): Promise<BgTask> {
    return registry.startTask(registryContext(ctx), command, options);
  }

  async function openTaskManager(
    ctx: ExtensionCommandContext | ExtensionContext,
    initialTaskId?: string,
  ): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        'Background task manager requires an interactive Pi UI. Use /jobs, /logs, or the bg_status/bg_logs tools in non-interactive mode.',
        'error',
      );
      return;
    }
    const normalOptions: OverlayOptions = {
      anchor: 'top-right',
      width: 96,
      minWidth: 64,
      margin: { top: 1, left: 1, right: 1 },
    };
    // Pi resolves overlayOptions once (at overlay creation), so a fullscreen toggle
    // re-creates the overlay with the same manager instance and fresh options.
    const fullscreenOptions = (): OverlayOptions => ({
      anchor: 'top-left',
      width: '100%',
      maxHeight: Math.max(
        1,
        process.stdout.rows - FULLSCREEN_MARGINS.top - FULLSCREEN_MARGINS.bottom,
      ),
      margin: FULLSCREEN_MARGINS,
    });

    const { BackgroundTasksManager } = await taskManagerLoader.run((runtime) => runtime);
    let manager: BackgroundTasksManager | null = null;
    let currentHandle: OverlayHandle | null = null;
    let rawTui: TUI | null = null;

    const rePresent = (options: OverlayOptions) => {
      if (!manager || !rawTui) return;
      currentHandle?.hide();
      currentHandle = rawTui.showOverlay(manager, options);
    };

    const managerOptions: TaskManagerOptions = {
      getTasks: () => registry.allTasks(),
      stopTask: async (task: BackgroundTaskForUi) => {
        await registry.stopTask(registry.resolveTask(task.id), 'user');
      },
      stopAllRunning: async () => {
        const result = await registry.stopAllRunning('user');
        return result;
      },
      rerunTask: async (task: BackgroundTaskForUi) => {
        const rerunOptions: StartTaskOptions = {
          name: taskDisplayName(task),
          notifyOnCompletion: true,
          triggerOnCompletion: false,
        };
        if (task.description !== undefined) rerunOptions.description = task.description;
        if (task.timeoutSeconds !== undefined) rerunOptions.timeoutSeconds = task.timeoutSeconds;
        const rerun = await startTask(ctx, task.command, rerunOptions);
        return rerun;
      },
      showOutputPath: (task: BackgroundTaskForUi) => {
        ctx.ui.notify(
          `Output path for ${taskDisplayName(task)} (${task.id}):\n${task.outputPath}`,
          'info',
        );
      },
      deleteTask: async (task: BackgroundTaskForUi) => {
        await registry.cleanupFinishedTasks('one', task.id);
      },
      onFullscreenToggle: (fullscreen) =>
        rePresent(fullscreen ? fullscreenOptions() : normalOptions),
      onClose: () => {
        currentHandle?.hide();
        currentHandle = null;
      },
    };

    await ctx.ui.custom(
      (tui, theme, _keybindings, done) => {
        rawTui = tui;
        const created = new BackgroundTasksManager(tui, theme, done, {
          ...managerOptions,
          ...(initialTaskId ? { initialTaskId } : {}),
        });
        manager = created;
        return created;
      },
      {
        overlay: true,
        overlayOptions: normalOptions,
        onHandle: (handle) => {
          currentHandle = handle;
        },
      },
    );
  }

  pi.registerMessageRenderer<BgTaskSnapshot>(
    'background-task-notification',
    (message, _options, theme) => {
      const task = message.details;
      const status = task?.status ?? 'completed';
      const color: ThemeColor =
        status === 'completed'
          ? 'success'
          : status === 'failed'
            ? 'error'
            : status === 'killed'
              ? 'warning'
              : 'accent';
      const id = task?.id ?? 'background task';
      const name = task ? taskDisplayName(task) : 'Background task';
      const output = task?.outputPath ? `\n${theme.fg('dim', `Output: ${task.outputPath}`)}` : '';
      const error = task?.error ? `\n${theme.fg('error', task.error)}` : '';
      return new Text(
        `${theme.fg(color, `[bg ${status}]`)} ${theme.fg('accent', name)} ${theme.fg('dim', `(${id})`)}${output}${error}`,
        0,
        0,
      );
    },
  );

  pi.on('session_shutdown', async (event, ctx) => {
    if (shutdownReason.length === 0) shutdownReason = event.reason;
    // Explicitly user-visible sessions always kill running tasks, while /reload,
    // a Pi restart or a crash cannot reach this handler and thus never kill: the
    // tasks survive and the next activation adopts them from disk.
    try {
      const running = registry.allTasks().filter((task) => task.status === 'running');
      if (running.length === 0) return;

      const failures: string[] = [];
      await Promise.all(
        running.map(async (task) => {
          try {
            await registry.stopTask(
              task,
              'shutdown',
              `Killed during Pi session shutdown (${event.reason})`,
            );
          } catch (error) {
            const message = `${task.id}: ${error instanceof Error ? error.message : String(error)}`;
            failures.push(message);
            console.error(`[background-tasks] shutdown cleanup failed for ${message}`);
          }
        }),
      );
      if (failures.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`Background task cleanup failed:\n${failures.join('\n')}`, 'error');
      }
    } finally {
      eventService.close();
    }
  });

  pi.registerCommand('bg', {
    description: 'Start a tracked shell command: /bg [--name "Task name"] <command>',
    handler: async (args, ctx) => {
      try {
        const parsed = parseBgCommandArgs(args);
        const taskOptions: StartTaskOptions = {
          notifyOnCompletion: true,
          triggerOnCompletion: false,
        };
        if (parsed.name !== undefined) taskOptions.name = parsed.name;
        const task = await startTask(ctx, parsed.command, taskOptions);
        ctx.ui.notify(
          `Started ${taskDisplayName(task)} (${task.id})\nOutput: ${task.outputPath}\nCommand: ${task.command}`,
          'info',
        );
      } catch (error) {
        ctx.ui.notify(
          `Background task failed to start: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerCommand('tasks', {
    description: 'Open the background task manager UI',
    handler: async (args, ctx) => {
      const taskId = optionalTrimmed(args);
      await openTaskManager(ctx, taskId);
    },
  });

  pi.registerShortcut('shift+down' satisfies KeyId, {
    description: 'Open the background task manager',
    handler: async (ctx) => {
      await openTaskManager(ctx);
    },
  });
  pi.registerShortcut('ctrl+alt+b' satisfies KeyId, {
    description: 'Open the background task manager',
    handler: async (ctx) => {
      await openTaskManager(ctx);
    },
  });

  pi.registerCommand('jobs', {
    description: 'List running and recent background tasks',
    handler: (_args, ctx) => {
      ctx.ui.notify(
        formatSnapshotList(registry.allTasks().map((task) => registry.snapshot(task))),
        'info',
      );
      return Promise.resolve();
    },
  });

  pi.registerCommand('logs', {
    description: 'Show bounded output from a background task: /logs <id> [maxBytes]',
    getArgumentCompletions: (prefix) => {
      const matches = registry
        .allTasks()
        .filter((task) => task.id.startsWith(prefix.trim()))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: `${task.status} — ${truncateChars(task.command, 60)}`,
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        const [id, bytes] = args.trim().split(/\s+/, 2);
        const task = registry.resolveTask(id ?? '');
        const maxBytes = normalizeMaxBytes(Number(bytes), DEFAULT_LOG_BYTES);
        const logs = await registry.getTaskLogs(task, maxBytes, true);
        ctx.ui.notify(logs.text, 'info');
      } catch (error) {
        ctx.ui.notify(
          `Background logs error: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerCommand('kill', {
    description: 'Stop a running background task: /kill <id>',
    getArgumentCompletions: (prefix) => {
      const matches = registry
        .allTasks()
        .filter((task) => task.status === 'running' && task.id.startsWith(prefix.trim()))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: truncateChars(task.command, 70),
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        const task = registry.resolveTask(args.trim());
        await registry.stopTask(task, 'user');
        ctx.ui.notify(
          `Killed ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`,
          'info',
        );
      } catch (error) {
        ctx.ui.notify(
          `Background kill error: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerCommand('clean', {
    description: 'Delete finished background tasks: /clean [session|all|<id>]',
    getArgumentCompletions: (prefix) => {
      const p = prefix.trim();
      const scopes = ['session', 'all'].filter((s) => s.startsWith(p));
      const ids = registry
        .allTasks()
        .filter((task) => task.status !== 'running' && task.id.startsWith(p))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: `${task.status} — ${truncateChars(task.command, 60)}`,
        }));
      const matches = [
        ...scopes.map((s) => ({ value: s, label: s, description: 'scope' })),
        ...ids,
      ];
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const arg = (args ?? '').trim();
      let scope: CleanupScope;
      let taskId: string | undefined;
      if (arg === 'all') {
        scope = 'all';
      } else if (arg === 'session' || arg === '') {
        scope = 'session';
      } else {
        scope = 'one';
        taskId = arg;
      }
      try {
        const summary = await registry.cleanupFinishedTasks(scope, taskId);
        ctx.ui.notify(formatCleanMessage(summary), 'info');
      } catch (error) {
        ctx.ui.notify(
          `Background clean error: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerTool<typeof BgRunParams, BgRunDetails>({
    name: 'bg_run',
    label: 'Background Run',
    description: `Start a named long-running shell command in the background and return immediately with a task ID and output path. By default, completed, failed, or killed terminal state is delivered automatically as <background-task-notification> and starts a follow-up agent turn; do not sleep or poll merely to wait. Output is written to ${config.tasksDir} and model-visible logs are bounded to ${formatSize(MAX_LOG_BYTES)}.`,
    promptSnippet:
      'Start a named long-running shell command; default terminal notification wakes a follow-up turn, so yield instead of polling',
    promptGuidelines: [
      'Use bg_run instead of bash for commands expected to run for a long time, such as test suites, dev servers, watchers, or builds.',
      'When using bg_run, always set name to a concise 2-6 word human-readable label; do not use the raw command as the name unless it is already short and meaningful.',
      'bg_run returns immediately. With notifyOnCompletion:true and triggerOnCompletion:true (both defaults), completed, failed, or killed terminal state is delivered as <background-task-notification> and automatically starts a follow-up agent turn.',
      'After a default bg_run launch, continue only independent useful work that does not merely wait for the task; otherwise briefly acknowledge it if useful, then end the current turn. Do not call sleep, bg_status, or bg_logs merely to wait; the terminal notification will wake you.',
      'Treat <background-task-notification> as durable terminal truth. Do not call bg_status to reconfirm it; call bg_logs only when the task output is needed.',
      'Use bg_status/bg_logs only when the user explicitly requests an update, automatic notification or wake-up was deliberately disabled, there is concrete evidence the task is hung, or a terminal notification arrived and output details are needed.',
      'Do not set notifyOnCompletion:false or triggerOnCompletion:false unless intentionally opting out of automatic completion handling.',
    ],
    parameters: BgRunParams,
    prepareArguments(args): BgRunParamsValue {
      if (!args || typeof args !== 'object') throw new Error('bg_run arguments must be an object');
      const input = args as BgToolArgumentRecord;
      if (typeof input.command !== 'string') throw new Error('bg_run requires command string');
      // Legacy surviveReload values are silently ignored: task survival across
      // /reload is now the only behavior, so the knob has nothing left to set.
      const prepared: BgRunParamsValue = {
        command: input.command,
        name:
          normalizeTaskName(input.name) ??
          normalizeTaskName(input.description) ??
          deriveTaskNameFromCommand(input.command),
      };
      if (typeof input.description === 'string') prepared.description = input.description;
      if (typeof input.timeoutSeconds === 'number') prepared.timeoutSeconds = input.timeoutSeconds;
      if (typeof input.notifyOnCompletion === 'boolean')
        prepared.notifyOnCompletion = input.notifyOnCompletion;
      if (typeof input.triggerOnCompletion === 'boolean')
        prepared.triggerOnCompletion = input.triggerOnCompletion;
      return prepared;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const taskOptions: StartTaskOptions = {
        name: params.name,
        notifyOnCompletion: params.notifyOnCompletion ?? true,
        triggerOnCompletion: params.triggerOnCompletion ?? true,
      };
      if (params.description !== undefined) taskOptions.description = params.description;
      if (params.timeoutSeconds !== undefined) taskOptions.timeoutSeconds = params.timeoutSeconds;
      const task = await startTask(ctx, params.command, taskOptions);
      const completionDelivery = deriveCompletionDeliveryGuidance(
        task.notifyOnCompletion,
        task.triggerOnCompletion,
      );
      return {
        content: textContent(
          `Started background task ${taskDisplayName(task)} (${task.id})\nStatus: ${task.status}\nPID: ${String(task.pid ?? 'unknown')}\nOutput: ${task.outputPath}\n${completionDelivery.text}`,
        ),
        details: { task: registry.snapshot(task) },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_run '))}${theme.fg('muted', truncateChars(taskDisplayName(args), COMMAND_PREVIEW_CHARS))}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const { task } = result.details;
      return new Text(
        `${theme.fg('success', '✓ started')} ${theme.fg('accent', taskDisplayName(task))} ${theme.fg('dim', `(${task.id})`)}\n${theme.fg('dim', `Output: ${task.outputPath}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof BgStatusParams, BgStatusDetails>({
    name: 'bg_status',
    label: 'Background Status',
    description:
      'Inspect one background task or list all running/recent background tasks. This is a point-in-time inspection tool, not a waiting primitive.',
    promptSnippet:
      'Inspect point-in-time status for one or all background tasks; never poll it as a wait loop',
    promptGuidelines: [
      'Use bg_status for deliberate point-in-time inspection, not as a waiting primitive.',
      'A running result is not an instruction to poll again. Do not repeatedly call bg_status while an automatic terminal notification is pending.',
      'Use bg_status when the user explicitly requests an update, automatic completion handling was disabled, or concrete evidence suggests a task is hung; terminal notifications do not need reconfirmation.',
    ],
    parameters: BgStatusParams,
    execute(_toolCallId, params) {
      const selected = params.taskId ? [registry.resolveTask(params.taskId)] : registry.allTasks();
      const snapshots = selected.map((task) => registry.snapshot(task));
      return Promise.resolve({
        content: textContent(formatSnapshotList(snapshots)),
        details: { tasks: snapshots },
      });
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_status'))}${args.taskId ? ` ${theme.fg('accent', args.taskId)}` : ''}`,
        0,
        0,
      );
    },
    renderResult: renderPlainResult,
  });

  pi.registerTool<typeof BgLogsParams, BgLogsDetails>({
    name: 'bg_logs',
    label: 'Background Logs',
    description: `Read bounded output from a background task for deliberate inspection; this is not a waiting primitive. Output is capped at ${formatSize(MAX_LOG_BYTES)} for model safety and points to the full output file when truncated.`,
    promptSnippet: 'Read bounded task output when needed; never tail it repeatedly as a wait loop',
    promptGuidelines: [
      'Use bg_logs with a modest maxBytes value only when task output is needed, without flooding context.',
      'Do not repeatedly call bg_logs to wait for completion while an automatic terminal notification is pending.',
      'Use bg_status first only when a deliberate inspection requires the current task state; do not reconfirm a terminal notification.',
    ],
    parameters: BgLogsParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      const logs = await registry.getTaskLogs(
        task,
        normalizeMaxBytes(params.maxBytes),
        params.tail ?? true,
      );
      return {
        content: textContent(logs.text),
        details: logs.details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_logs '))}${theme.fg('accent', args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      let text = `${theme.fg('accent', taskDisplayName(details.task))} ${theme.fg('dim', `(${details.task.id})`)} ${theme.fg('muted', details.tail ? 'tail' : 'head')} ${formatSize(details.bytesRead)}`;
      if (details.truncated) text += theme.fg('warning', ' (truncated)');
      text += `\n${theme.fg('dim', `Full output: ${details.path}`)}`;
      if (expanded) {
        const output = result.content
          .map((content) => (content.type === 'text' ? content.text : '[image content]'))
          .join('\n');
        text += `\n${theme.fg('toolOutput', output.split('\n').slice(0, 30).join('\n'))}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<typeof BgKillParams, BgKillDetails>({
    name: 'bg_kill',
    label: 'Background Kill',
    description:
      'Stop a running background task by ID. Fails loudly if the task is unknown or already finished.',
    promptSnippet: 'Stop a running background task by ID',
    promptGuidelines: [
      'Use bg_kill when the user asks to stop a background task or when a bg_run command is no longer needed.',
    ],
    parameters: BgKillParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      await registry.stopTask(task, 'user');
      const message = `Killed background task ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`;
      return {
        content: textContent(message),
        details: { task: registry.snapshot(task), message },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_kill '))}${theme.fg('accent', args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const { task } = result.details;
      return new Text(
        `${theme.fg('warning', '■ killed')} ${theme.fg('accent', taskDisplayName(task))} ${theme.fg('dim', `(${task.id})`)}\n${theme.fg('dim', `Output: ${task.outputPath}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof BgCleanParams, BgCleanDetails>({
    name: 'bg_clean',
    label: 'Background Clean',
    description:
      'Delete finished background tasks to free their disk space. Only terminal tasks (completed/failed/killed) are removed; running tasks are left alone and reported. Scope: a single task by ID, all of this session (default), or the entire tasks folder.',
    promptSnippet: 'Delete finished background tasks',
    promptGuidelines: [
      'Use bg_clean when the user asks to clean up, remove, or free space from finished background tasks.',
      'bg_clean never deletes a running task; it reports any running tasks it skipped.',
      'By default it cleans this session; pass scope:"all" to clean the entire tasks folder.',
    ],
    parameters: BgCleanParams,
    async execute(_toolCallId, params) {
      const scope: CleanupScope = params.taskId ? 'one' : (params.scope ?? 'session');
      const summary = await registry.cleanupFinishedTasks(scope, params.taskId);
      return {
        content: textContent(formatCleanMessage(summary)),
        details: {
          scope,
          deleted: summary.deleted,
          skipped: summary.skipped,
          notFound: summary.notFound,
        },
      };
    },
    renderCall(args, theme) {
      const target = args.taskId ?? args.scope ?? 'session';
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_clean'))} ${theme.fg('accent', target)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details;
      let text = `${theme.fg('muted', `scope=${d.scope}`)} ${theme.fg('accent', `${d.deleted.length} deleted`)}`;
      if (d.skipped.length > 0)
        text += ` ${theme.fg('warning', `${d.skipped.length} skipped (running)`)}`;
      if (d.notFound.length > 0)
        text += ` ${theme.fg('warning', `${d.notFound.length} not found`)}`;
      if (expanded) {
        for (const item of d.deleted)
          text += `\n  ✓ ${theme.fg('accent', item.id)} ${theme.fg('dim', item.status)}`;
        for (const item of d.skipped)
          text += `\n  ▶ ${theme.fg('accent', item.id)} ${theme.fg('dim', 'running, kept')}`;
        for (const n of d.notFound) text += `\n  ${theme.fg('warning', n)}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
