import { accessSync, constants, statSync, type WriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, join, resolve, win32 } from 'node:path';
import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent';
import type { BackgroundTaskChildProcess } from './registry.js';

export const TASK_STATUS_VALUES = ['running', 'completed', 'failed', 'killed'] as const;
export const TERMINAL_TASK_STATUS_VALUES = ['completed', 'failed', 'killed'] as const;

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUS_VALUES)[number];
export type KillKind = 'user' | 'timeout' | 'output_cap' | 'shutdown';
export type ReloadShellStopKind = KillKind | 'handoff_expired';

export type TerminalPublicationState = 'pending' | 'delivered' | 'abandoned';
export type TerminalPublicationAbandonReason =
  | 'registry_shutdown'
  | 'publisher_closed'
  | 'gate_rejected'
  | 'retry_exhausted'
  | 'retention_limit'
  | 'reload_handoff_expired';

export type ReloadSurvivalErrorCode =
  | 'pi_bg_survive_reload_invalid'
  | 'pi_bg_survive_reload_requires_non_agent'
  | 'pi_bg_survive_reload_unsupported_task_kind'
  | 'pi_bg_reload_owner_unavailable'
  | 'pi_bg_reload_owner_protocol_incompatible'
  | 'pi_bg_reload_owner_activation_conflict'
  | 'pi_bg_reload_owner_stale_claim'
  | 'pi_bg_reload_handoff_expired';

export class ReloadSurvivalError extends Error {
  constructor(
    readonly code: ReloadSurvivalErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ReloadSurvivalError';
  }
}

export interface ReloadSurvivalSnapshotV1 {
  schemaVersion: 'pi-background-tasks.reload-shell.v1';
  authority: 'same-process-live-owner';
  hostPid: number;
  sessionId: string;
  cwdRealpath: string;
  launchNonce: string;
  completionId: string;
  spawnedAt: number;
  childPid: number;
  timeoutDeadlineAt?: number | undefined;
  outputCapBytes: number;
  posixProcessGroupId?: number | undefined;
  windowsTreeRootPid?: number | undefined;
  leaseGeneration: number;
  handoffCount: number;
}

export interface ReloadShellIdentityV1 {
  readonly hostPid: number;
  readonly sessionId: string;
  readonly cwdRealpath: string;
}

export interface ReloadShellActivationLeaseV1 {
  readonly protocol: 'pi-background-tasks.reload-shell-owner.v1';
  readonly hubNonce: string;
  readonly identityKey: string;
  readonly generation: number;
  readonly activationNonce: string;
}

export interface ReloadShellActivationClaimV1 {
  readonly protocol: 'pi-background-tasks.reload-shell-owner.v1';
  readonly hubNonce: string;
  readonly claimNonce: string;
  readonly identity: ReloadShellIdentityV1;
  readonly identityKey: string;
  readonly generation: number;
  readonly activationNonce: string;
  readonly expiresAt?: number | undefined;
  readonly executions: readonly ReloadableShellExecutionV1[];
}

export interface ReloadShellProcessV1 {
  readonly pid?: number | undefined;
  stdout?:
    | {
        on(event: 'data', listener: (data: Buffer | string) => void): unknown;
        off?(event: 'data', listener: (data: Buffer | string) => void): unknown;
      }
    | null
    | undefined;
  stderr?:
    | {
        on(event: 'data', listener: (data: Buffer | string) => void): unknown;
        off?(event: 'data', listener: (data: Buffer | string) => void): unknown;
      }
    | null
    | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off?(event: 'error', listener: (error: Error) => void): unknown;
  off?(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface ReloadShellOwnerEventSinkV1 {
  readonly onChanged: (execution: ReloadableShellExecutionV1) => void;
  readonly onTerminal: (execution: ReloadableShellExecutionV1) => void;
}

export type ReloadShellNotificationState = 'disabled' | 'pending' | 'sending' | 'delivered';

export interface ReloadableShellExecutionV1 {
  readonly protocol: 'pi-background-tasks.reload-shell-owner.v1';
  readonly launchNonce: string;
  readonly completionId: string;
  readonly task: BgTask;
  child: ReloadShellProcessV1 | undefined;
  outputStream: WriteStream | undefined;
  readonly spawnedAt: number;
  readonly timeoutDeadlineAt?: number | undefined;
  readonly outputCapBytes: number;
  readonly terminal: Promise<BgTask>;
  readonly requestStop: (kind: ReloadShellStopKind, reason?: string) => Promise<BgTask>;
  phase: 'starting' | 'running' | 'stop_requested' | 'finalizing' | 'terminal' | 'released';
  closeObservation?:
    | {
        code: number | null;
        signal: NodeJS.Signals | null;
        observedAt: number;
      }
    | undefined;
  admissionCommitted: boolean;
  notificationState: ReloadShellNotificationState;
  readonly commitInitialMetadata: (signal?: AbortSignal) => Promise<void>;
  readonly failAdmission: (error: Error) => void;
  readonly setOwnerEventSink: (sink: ReloadShellOwnerEventSinkV1 | undefined) => void;
  readonly markAdmissionCommitted: (generation: number, handoffCount: number) => void;
  readonly updateLeaseAudit: (generation: number, handoffCount: number) => void;
  readonly abandonReloadHandoff: () => void;
  readonly beginNotification: (lease: ReloadShellActivationLeaseV1) => string | undefined;
  readonly finishNotification: (token: string, delivered: boolean) => void;
  readonly releaseResources: () => void;
}

export interface ReloadShellHostAdapterV1 {
  readonly activationNonce: string;
  readonly onBound: (lease: ReloadShellActivationLeaseV1) => void;
  readonly onChanged: (execution: ReloadableShellExecutionV1) => void;
  readonly onTerminal: (execution: ReloadableShellExecutionV1) => void;
}

export interface ReloadShellOwnerHubV1 {
  readonly protocol: 'pi-background-tasks.reload-shell-owner.v1';
  readonly hubNonce: string;
  beginActivation(
    identity: ReloadShellIdentityV1,
    startReason: string,
    activationNonce: string,
  ): ReloadShellActivationClaimV1;
  commitActivation(
    claim: ReloadShellActivationClaimV1,
    adapter: ReloadShellHostAdapterV1,
  ): ReloadShellActivationLeaseV1;
  abortActivation(claim: ReloadShellActivationClaimV1, error: unknown): void;
  beginReloadHandoff(lease: ReloadShellActivationLeaseV1): readonly ReloadableShellExecutionV1[];
  releaseActivation(lease: ReloadShellActivationLeaseV1): void;
  registerExecution(
    lease: ReloadShellActivationLeaseV1,
    execution: ReloadableShellExecutionV1,
  ): void;
  markAdmissionCommitted(
    lease: ReloadShellActivationLeaseV1,
    execution: ReloadableShellExecutionV1,
  ): void;
  releaseExecution(
    leaseOrClaim: ReloadShellActivationLeaseV1 | ReloadShellActivationClaimV1,
    execution: ReloadableShellExecutionV1,
  ): void;
  isCurrentLease(lease: ReloadShellActivationLeaseV1): boolean;
}

export interface BgTaskSnapshot {
  id: string;
  name?: string | undefined;
  command: string;
  description?: string | undefined;
  status: TaskStatus;
  outputPath: string;
  cwd: string;
  startTime: number;
  endTime?: number | undefined;
  exitCode?: number | null | undefined;
  signal?: string | null | undefined;
  pid?: number | undefined;
  bytesWritten: number;
  surviveReload: boolean;
  reloadSurvival?: ReloadSurvivalSnapshotV1 | undefined;
  error?: string | undefined;
  notified: boolean;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  timeoutSeconds?: number | undefined;
  /** Immutable non-secret shell selection for ordinary shell tasks. */
  shellPolicy?: ShellPolicySnapshot | undefined;
}

export interface BgTask extends Omit<BgTaskSnapshot, 'name'> {
  name: string;
  outputAbsPath: string;
  metadataAbsPath: string;
  eventsAbsPath?: string | undefined;
  stderrAbsPath?: string | undefined;
  child?: BackgroundTaskChildProcess | undefined;
  /** Immutable in-memory ownership captured from a detached POSIX spawn; never restored from metadata. */
  ownedPosixProcessGroupId?: number | undefined;
  /** One-way latch preventing any later signal after group authority is released. */
  posixProcessGroupSignalAuthorityReleased?: boolean | undefined;
  stream?: WriteStream | undefined;
  timeoutHandle?: NodeJS.Timeout | undefined;
  killKind?: KillKind | undefined;
  killSignalSent?: boolean | undefined;
  killEscalationTimer?: NodeJS.Timeout | undefined;
  capExceeded?: boolean | undefined;
  finalized?: boolean | undefined;
  /** True only after the terminal EventBus emitter returns successfully; abandonment is never delivery. */
  terminalPublished: boolean;
  terminalPublicationState: TerminalPublicationState;
  terminalPublicationAbandonReason?: TerminalPublicationAbandonReason | undefined;
  terminalPublishAttempts: number;
  terminalPublishInFlight?: boolean | undefined;
  /** True only while the synchronous terminal emitter itself is on the stack. */
  terminalEmitInFlight?: boolean | undefined;
  terminalPublishRetryHandle?: NodeJS.Timeout | undefined;
  /** Optional protocol barrier used by EventBus run requests so early child exits cannot publish before the run response is observable. */
  terminalPublicationGate?: Promise<void> | undefined;
  /** In-memory same-process authority for an opted ordinary shell task; never serialized. */
  reloadExecution?: ReloadableShellExecutionV1 | undefined;
  /** Fresh-registry terminal host delivery state for an imported owner execution. */
  reloadHostDeliveryInFlight?: boolean | undefined;
  reloadHostDeliverySettled?: boolean | undefined;
  reloadHostNotificationSettled?: boolean | undefined;
  metadataWriteChain?: Promise<void> | undefined;
  waiters: Array<() => void>;
}

export type CompletionDeliveryMode =
  | 'notification-and-wake'
  | 'notification-only'
  | 'manual-monitoring';

interface CompletionDeliveryGuidance {
  readonly mode: CompletionDeliveryMode;
  readonly notificationEnabled: boolean;
  readonly automaticWakeEnabled: boolean;
  readonly text: string;
}

/**
 * Describe the actual parent-agent completion path for one bg_run launch.
 * A wake request cannot take effect without the notification that carries it.
 */
export function deriveCompletionDeliveryGuidance(
  notifyOnCompletion: boolean,
  triggerOnCompletion: boolean,
): CompletionDeliveryGuidance {
  if (notifyOnCompletion && triggerOnCompletion) {
    return {
      mode: 'notification-and-wake',
      notificationEnabled: true,
      automaticWakeEnabled: true,
      text: [
        'Terminal notification: enabled.',
        'Automatic follow-up turn: enabled.',
        'Next action: do not poll or sleep merely to wait; continue only independent useful work, otherwise end this turn and wait for <background-task-notification>.',
      ].join('\n'),
    };
  }

  if (notifyOnCompletion) {
    return {
      mode: 'notification-only',
      notificationEnabled: true,
      automaticWakeEnabled: false,
      text: [
        'Terminal notification: enabled.',
        'Automatic follow-up turn: disabled. The terminal notification will be delivered, but it will not start an agent turn.',
        'Next action: automatic wake-up was explicitly disabled; use bg_status/bg_logs only when deliberate monitoring is required, without tight polling.',
      ].join('\n'),
    };
  }

  return {
    mode: 'manual-monitoring',
    notificationEnabled: false,
    automaticWakeEnabled: false,
    text: [
      'Terminal notification: disabled.',
      triggerOnCompletion
        ? 'Automatic follow-up turn: disabled because terminal notifications are disabled. triggerOnCompletion has no effect while notifyOnCompletion is false.'
        : 'Automatic follow-up turn: disabled.',
      'Next action: completion delivery was explicitly disabled; use bg_status/bg_logs only for deliberate manual monitoring, without tight polling.',
    ].join('\n'),
  };
}

export interface BgRunDetails {
  task: BgTaskSnapshot;
}

export interface BgStatusDetails {
  tasks: BgTaskSnapshot[];
}

export interface BgLogsDetails {
  task: BgTaskSnapshot;
  path: string;
  bytesRead: number;
  truncated: boolean;
  tail: boolean;
}

export interface BgKillDetails {
  task: BgTaskSnapshot;
  message: string;
}

export interface StartTaskOptions {
  name?: string | undefined;
  description?: string | undefined;
  timeoutSeconds?: number | undefined;
  notifyOnCompletion?: boolean | undefined;
  triggerOnCompletion?: boolean | undefined;
  surviveReload?: boolean | undefined;
  /** @internal EventBus protocol barrier; callers should not set this outside the extension service. */
  terminalPublicationGate?: Promise<void> | undefined;
}

export const DEFAULT_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024);
export const MAX_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024);
export const COMMAND_PREVIEW_CHARS = 90;

export function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'session';
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function normalizeTaskName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = compactWhitespace(stripMatchingQuotes(value));
  if (!normalized) return undefined;
  return truncateChars(normalized, 80);
}

export function deriveTaskNameFromCommand(command: string): string {
  const normalized = compactWhitespace(stripMatchingQuotes(command));
  if (!normalized) return 'Background task';

  const packageScript = /^(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([^\s;&|]+)/.exec(normalized);
  if (packageScript) {
    const runner = packageScript[1] ?? 'npm';
    const run = packageScript[2] !== undefined ? ' run' : '';
    const script = packageScript[3] ?? '';
    return truncateChars(`${runner}${run} ${script}`, 48);
  }

  const words = normalized.split(/\s+/).slice(0, 5).join(' ');
  return truncateChars(words.length > 0 ? words : normalized, 48);
}

export function taskDisplayName(task: {
  name?: string | undefined;
  description?: string | undefined;
  command?: string | undefined;
  id?: string | undefined;
}): string {
  const commandName =
    task.command && task.command.length > 0 ? deriveTaskNameFromCommand(task.command) : undefined;
  return (
    normalizeTaskName(task.name) ??
    normalizeTaskName(task.description) ??
    commandName ??
    task.id ??
    'Background task'
  );
}

function parseNameValueAndRest(valueAndRest: string): { value: string; rest: string } | undefined {
  const input = valueAndRest.trimStart();
  if (!input) return undefined;
  const quote = input[0];
  if (quote === '"' || quote === "'") {
    let escaped = false;
    let value = '';
    for (let i = 1; i < input.length; i++) {
      const char = input.charAt(i);
      if (escaped) {
        value += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        return { value, rest: input.slice(i + 1).trimStart() };
      }
      value += char;
    }
    return undefined;
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) return undefined;
  const parsedValue = match[1];
  if (parsedValue === undefined) return undefined;
  return { value: parsedValue, rest: match[2]?.trimStart() ?? '' };
}

export function parseBgCommandArgs(args: string): {
  name?: string;
  command: string;
  surviveReload: boolean;
} {
  let input = args.trim();
  let name: string | undefined;
  let surviveReload = false;

  while (input) {
    let consumed = false;
    for (const prefix of ['--name=', '-n=']) {
      if (input.startsWith(prefix)) {
        const parsed = parseNameValueAndRest(input.slice(prefix.length));
        if (!parsed) throw new Error(`${prefix.slice(0, -1)} requires a task name`);
        name = normalizeTaskName(parsed.value);
        input = parsed.rest;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    for (const prefix of ['--name', '-n']) {
      if (input === prefix || input.startsWith(`${prefix} `) || input.startsWith(`${prefix}\t`)) {
        const parsed = parseNameValueAndRest(input.slice(prefix.length));
        if (!parsed) throw new Error(`${prefix} requires a task name`);
        name = normalizeTaskName(parsed.value);
        input = parsed.rest;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    if (
      input === '--survive-reload' ||
      input.startsWith('--survive-reload ') ||
      input.startsWith('--survive-reload\t')
    ) {
      if (surviveReload) {
        throw new ReloadSurvivalError(
          'pi_bg_survive_reload_invalid',
          '/bg accepts --survive-reload at most once',
        );
      }
      surviveReload = true;
      input = input.slice('--survive-reload'.length).trimStart();
      continue;
    }
    if (input.startsWith('--survive-reload=')) {
      throw new ReloadSurvivalError(
        'pi_bg_survive_reload_invalid',
        '/bg accepts only the bare --survive-reload flag',
      );
    }

    if (input === '--') {
      input = '';
      break;
    }
    if (input.startsWith('-- ')) {
      input = input.slice(3).trimStart();
      break;
    }
    break;
  }

  return name ? { name, command: input, surviveReload } : { command: input, surviveReload };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m${remSeconds > 0 ? `${String(remSeconds)}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${String(hours)}h${remMinutes > 0 ? `${String(remMinutes)}m` : ''}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export type ShellDialect = 'cmd' | 'posix' | 'user-non-posix';
export type ShellPolicyDialect = ShellDialect | 'bash';
export type ShellPolicyName = 'inherit' | 'bash' | 'sh' | 'cmd';

/** Non-secret launch facts persisted for ordinary shell tasks. */
export interface ShellPolicySnapshot {
  readonly policy: ShellPolicyName;
  readonly executable: string;
  readonly argvPrefix: readonly string[];
  readonly dialect: ShellPolicyDialect;
}

/** One immutable shell selection shared by guidance and every ordinary spawn in an activation. */
export interface ResolvedShellPolicy extends ShellPolicySnapshot {
  readonly supportsPosixFunctionWrapper: boolean;
  readonly windowsVerbatimArguments: boolean;
}

export interface ShellInvocation {
  shell: string;
  args: string[];
  dialect: ShellDialect;
  windowsVerbatimArguments: boolean;
}

export class ShellInvocationError extends Error {
  readonly code = 'pi_bg_shell_invalid';

  constructor(message: string) {
    super(`pi_bg_shell_invalid: ${message}`);
    this.name = 'ShellInvocationError';
  }
}

type ShellCandidateResult =
  | { readonly found: true }
  | { readonly found: false; readonly diagnostic: string };

const POSIX_FUNCTION_SHELLS = new Set([
  'sh',
  'dash',
  'ash',
  'ksh',
  'ksh93',
  'mksh',
  'pdksh',
  'zsh',
  'yash',
  'posh',
]);

function failShellInvocation(message: string): never {
  throw new ShellInvocationError(message);
}

function shellErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freezeShellPolicy(
  policy: Omit<ResolvedShellPolicy, 'argvPrefix'> & { argvPrefix: readonly string[] },
): ResolvedShellPolicy {
  return Object.freeze({
    ...policy,
    argvPrefix: Object.freeze([...policy.argvPrefix]),
  });
}

export function shellPolicySnapshot(policy: ResolvedShellPolicy): ShellPolicySnapshot {
  return Object.freeze({
    policy: policy.policy,
    executable: policy.executable,
    argvPrefix: Object.freeze([...policy.argvPrefix]),
    dialect: policy.dialect,
  });
}

function isWindowsExecutablePath(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === '.exe' || extension === '.com';
}

function validateWindowsShellPath(path: string, label: string): string {
  if (path.length === 0) failShellInvocation(`${label} is empty`);
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    failShellInvocation(`${label} must be an absolute path`);
  }
  if (!isWindowsExecutablePath(path)) {
    failShellInvocation(`${label} must point to a .exe or .com file`);
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    failShellInvocation(`${label} stat failed: ${shellErrorMessage(error)}`);
  }
  if (!stats.isFile()) failShellInvocation(`${label} must point to a regular file`);
  return path;
}

function inspectWindowsShellCandidate(path: string): ShellCandidateResult {
  if (!isWindowsExecutablePath(path)) {
    return { found: false, diagnostic: `${path} is not a .exe or .com path` };
  }
  try {
    const stats = statSync(path);
    if (stats.isFile()) return { found: true };
    return { found: false, diagnostic: `${path} is not a regular file` };
  } catch (error) {
    return { found: false, diagnostic: `${path}: ${shellErrorMessage(error)}` };
  }
}

function windowsPathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

function resolveWindowsBash(env: NodeJS.ProcessEnv): string {
  const pathValue = windowsPathValue(env);
  const diagnostics: string[] = [];
  for (const dir of pathValue.split(';').filter((entry) => entry.length > 0)) {
    for (const name of ['bash.exe', 'bash.com']) {
      const candidate = join(dir, name);
      const result = inspectWindowsShellCandidate(candidate);
      if (result.found) return candidate;
      diagnostics.push(result.diagnostic);
    }
  }
  const suffix = diagnostics.length > 0 ? `: ${diagnostics.join('; ')}` : '';
  failShellInvocation(`PI_BG_SHELL=bash could not resolve bash.exe or bash.com on PATH${suffix}`);
}

function validatePosixShellPath(path: string, label: string): string {
  if (path.length === 0) failShellInvocation(`${label} is empty`);
  if (!isAbsolute(path)) failShellInvocation(`${label} must be an absolute path`);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    failShellInvocation(`${label} stat failed: ${shellErrorMessage(error)}`);
  }
  if (!stats.isFile()) failShellInvocation(`${label} must point to a regular file`);
  try {
    accessSync(path, constants.X_OK);
  } catch (error) {
    failShellInvocation(`${label} must be executable: ${shellErrorMessage(error)}`);
  }
  return path;
}

function inspectPosixShellCandidate(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePosixExecutable(
  name: 'bash' | 'sh',
  env: NodeJS.ProcessEnv,
  activationCwd: string,
): string {
  const binCandidate = `/bin/${name}`;
  if (inspectPosixShellCandidate(binCandidate)) return binCandidate;
  const pathValue = env.PATH ?? '';
  for (const entry of pathValue.split(delimiter)) {
    if (entry.length === 0) continue;
    const directory = isAbsolute(entry) ? entry : resolve(activationCwd, entry);
    const candidate = join(directory, name);
    if (inspectPosixShellCandidate(candidate)) return candidate;
  }
  failShellInvocation(
    `PI_BG_POSIX_SHELL=${name} could not resolve executable ${binCandidate} or ${name} on PATH`,
  );
}

function inheritedPosixDialect(executable: string): ShellPolicyDialect {
  const name = basename(executable).toLowerCase();
  if (name === 'bash') return 'bash';
  return POSIX_FUNCTION_SHELLS.has(name) ? 'posix' : 'user-non-posix';
}

/** Resolve one activation-stable policy. New POSIX variables are intentionally ignored on Windows. */
export function resolveShellPolicy(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  activationCwd: string = process.cwd(),
): ResolvedShellPolicy {
  if (platform === 'win32') {
    const requestedShell = env.PI_BG_SHELL;
    const requestedPath = env.PI_BG_SHELL_PATH;
    if (requestedShell === undefined) {
      if (requestedPath !== undefined) failShellInvocation('PI_BG_SHELL_PATH requires PI_BG_SHELL');
      const comSpec = env.ComSpec;
      return freezeShellPolicy({
        policy: 'cmd',
        executable: comSpec && comSpec.length > 0 ? comSpec : 'cmd.exe',
        argvPrefix: ['/d', '/s', '/c'],
        dialect: 'cmd',
        supportsPosixFunctionWrapper: false,
        windowsVerbatimArguments: true,
      });
    }
    if (requestedShell !== 'cmd' && requestedShell !== 'bash') {
      failShellInvocation('PI_BG_SHELL must be exactly cmd or bash');
    }
    const explicitPath =
      requestedPath !== undefined
        ? validateWindowsShellPath(requestedPath, 'PI_BG_SHELL_PATH')
        : undefined;
    if (requestedShell === 'cmd') {
      const comSpec = env.ComSpec;
      return freezeShellPolicy({
        policy: 'cmd',
        executable: explicitPath ?? (comSpec && comSpec.length > 0 ? comSpec : 'cmd.exe'),
        argvPrefix: ['/d', '/s', '/c'],
        dialect: 'cmd',
        supportsPosixFunctionWrapper: false,
        windowsVerbatimArguments: true,
      });
    }
    return freezeShellPolicy({
      policy: 'bash',
      executable: explicitPath ?? resolveWindowsBash(env),
      argvPrefix: ['-c'],
      dialect: 'bash',
      supportsPosixFunctionWrapper: true,
      windowsVerbatimArguments: false,
    });
  }

  const configuredPolicy = env.PI_BG_POSIX_SHELL;
  if (
    configuredPolicy !== undefined &&
    configuredPolicy !== 'inherit' &&
    configuredPolicy !== 'bash' &&
    configuredPolicy !== 'sh'
  ) {
    failShellInvocation('PI_BG_POSIX_SHELL must be exactly inherit, bash, or sh');
  }
  const policy = configuredPolicy ?? 'inherit';
  const configuredPath = env.PI_BG_POSIX_SHELL_PATH;
  if (policy === 'inherit') {
    if (configuredPath !== undefined) {
      failShellInvocation(
        'PI_BG_POSIX_SHELL_PATH requires PI_BG_POSIX_SHELL=bash or PI_BG_POSIX_SHELL=sh',
      );
    }
    const inherited = env.SHELL;
    const executable = inherited && inherited.length > 0 ? inherited : '/bin/sh';
    const dialect = inheritedPosixDialect(executable);
    return freezeShellPolicy({
      policy,
      executable,
      argvPrefix: ['-c'],
      dialect,
      supportsPosixFunctionWrapper: dialect === 'bash' || dialect === 'posix',
      windowsVerbatimArguments: false,
    });
  }

  const executable =
    configuredPath !== undefined
      ? validatePosixShellPath(configuredPath, 'PI_BG_POSIX_SHELL_PATH')
      : resolvePosixExecutable(policy, env, activationCwd);
  return freezeShellPolicy({
    policy,
    executable,
    argvPrefix: ['-c'],
    dialect: policy === 'bash' ? 'bash' : 'posix',
    supportsPosixFunctionWrapper: true,
    windowsVerbatimArguments: false,
  });
}

export function shellInvocationForPolicy(
  command: string,
  policy: ResolvedShellPolicy,
): ShellInvocation {
  const dialect: ShellDialect = policy.dialect === 'bash' ? 'posix' : policy.dialect;
  return {
    shell: policy.executable,
    args:
      policy.dialect === 'cmd'
        ? [...policy.argvPrefix, `"${command}"`]
        : [...policy.argvPrefix, command],
    dialect,
    windowsVerbatimArguments: policy.windowsVerbatimArguments,
  };
}

export function normalizeMaxBytes(value: unknown, fallback = DEFAULT_LOG_BYTES): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(MAX_LOG_BYTES, raw));
}

export function snapshot(task: BgTask): BgTaskSnapshot {
  return {
    id: task.id,
    name: taskDisplayName(task),
    command: task.command,
    description: task.description,
    status: task.status,
    outputPath: task.outputPath,
    cwd: task.cwd,
    startTime: task.startTime,
    endTime: task.endTime,
    exitCode: task.exitCode,
    signal: task.signal,
    pid: task.pid,
    bytesWritten: task.bytesWritten,
    surviveReload: task.surviveReload === true,
    reloadSurvival: task.reloadSurvival,
    error: task.error,
    notified: task.notified,
    notifyOnCompletion: task.notifyOnCompletion,
    triggerOnCompletion: task.triggerOnCompletion,
    timeoutSeconds: task.timeoutSeconds,
    shellPolicy: task.shellPolicy,
  };
}

export function formatSnapshotList(tasks: BgTaskSnapshot[], now = Date.now()): string {
  if (tasks.length === 0) return 'No background tasks in this Pi extension runtime.';
  return tasks
    .map((task) => {
      const statusIcon =
        task.status === 'running'
          ? '▶'
          : task.status === 'completed'
            ? '✓'
            : task.status === 'killed'
              ? '■'
              : '✗';
      const age = formatDuration((task.endTime ?? now) - task.startTime);
      const code = task.exitCode !== undefined ? ` exit=${String(task.exitCode)}` : '';
      const pid = task.pid !== undefined ? ` pid=${String(task.pid)}` : '';
      const error = task.error ? ` error=${truncateChars(task.error, 80)}` : '';
      return `${statusIcon} ${task.id} ${task.status} ${age}${code}${pid} — ${truncateChars(taskDisplayName(task), COMMAND_PREVIEW_CHARS)}${error}\n    output: ${task.outputPath}`;
    })
    .join('\n');
}

export async function boundedRead(
  filePath: string,
  maxBytes: number,
  tail: boolean,
): Promise<{ content: string; truncated: boolean; bytesRead: number; totalBytes: number }> {
  const stats = statSync(filePath);
  const totalBytes = stats.size;
  const bytesToRead = Math.min(totalBytes, maxBytes);
  if (bytesToRead === 0) return { content: '', truncated: false, bytesRead: 0, totalBytes };

  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const position = tail ? Math.max(0, totalBytes - bytesToRead) : 0;
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
    return {
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: totalBytes > bytesRead,
      bytesRead,
      totalBytes,
    };
  } finally {
    await file.close();
  }
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
