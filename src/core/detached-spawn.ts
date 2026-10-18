import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type ResolvedShellPolicy, shellQuote } from './common.js';
import { writeFileFsynced } from './task-durable.js';

/**
 * Detached background-task spawning: the single launch path used by every task.
 *
 * The extension process never owns the child at runtime. There are no pipes, no
 * in-process output stream, and no handle that a same-process /reload could
 * lose. The ownership facts live outside the extension:
 *
 * - POSIX: the child starts fully detached, so it leads its own process group
 *   (`pgid === pid`) and signal authority is `-pgid`, valid from any process.
 * - Windows: the pid is recorded and `taskkill /T /F` owns the whole tree.
 * - Termination: the wrapper writes `<id>.exit` when the user command settles.
 *   Until and unless that marker exists, a running task's process liveness is
 *   probed via the recorded pid; the marker is the terminal source of truth.
 *
 * The registry can therefore adopt a running task purely from its on-disk
 * metadata, including tasks launched by an earlier extension activation (or an
 * earlier Pi process entirely).
 */

export const EXIT_MARKER_SUFFIX = '.exit';
export const RUNNER_SCRIPT_SUFFIX = '.runner.cmd';

export type DetachedWrapMode = 'posix' | 'cmd' | 'none';

export interface DetachedSpawnChild {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  unref?(): unknown;
}

export type DetachedSpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => DetachedSpawnChild;

export interface SpawnDetachedTaskOptions {
  readonly id: string;
  readonly taskDirAbs: string;
  readonly command: string;
  readonly policy: ResolvedShellPolicy;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawn?: DetachedSpawnFn | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

export interface SpawnDetachedTaskResult {
  readonly invocation: {
    readonly shell: string;
    readonly args: readonly string[];
    readonly windowsVerbatimArguments: boolean;
  };
  readonly exitMarkerFile: string;
  readonly exitMarkerTrusted: boolean;
  readonly runnerScriptFile?: string | undefined;
  readonly pid: number;
  readonly posixProcessGroupId?: number | undefined;
}

export function exitMarkerPath(taskDirAbs: string, id: string): string {
  return join(taskDirAbs, `${id}${EXIT_MARKER_SUFFIX}`);
}

export function runnerScriptPath(taskDirAbs: string, id: string): string {
  return join(taskDirAbs, `${id}${RUNNER_SCRIPT_SUFFIX}`);
}

/**
 * POSIX wrapper: run the user command in a subshell, then record its exit code
 * in the marker file. The marker is written before the wrapper exits, so the
 * marker always exists when the process has settled with a recon code.
 */
export function buildPosixWrappedCommand(command: string, exitMarkerFile: string): string {
  return [
    `( ${command} );`,
    'bgCode=$?;',
    `printf '%s\\n' "$bgCode" > ${shellQuote(exitMarkerFile)};`,
    'exit "$bgCode"',
  ].join(' ');
}

/**
 * Windows runner script: cmd processes each line independently, so a stray
 * parenthesis inside the user command cannot affect the epilogue. The
 * parenthesized `echo` prevents `%errorlevel%` digits being parsed as handle
 * redirections (`echo 1>file` redirects handle 1 and echoes an empty line).
 */
export function buildWindowsRunnerScript(command: string, exitMarkerFile: string): string {
  return [
    '@echo off',
    command,
    `(echo %errorlevel%)>"${exitMarkerFile}"`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
}

/** True for dialects the wrapper understands; 'none' loses exact exit codes. */
export function wrapModeForDialect(dialect: ResolvedShellPolicy['dialect']): DetachedWrapMode {
  if (dialect === 'posix' || dialect === 'bash') return 'posix';
  if (dialect === 'cmd') return 'cmd';
  return 'none';
}

/**
 * Spawn the user command fully detached with its output opened directly onto
 * the output file. If the wrapper could not be launched, cleanup is done
 * before any task admission is attempted, so a failure never leaves an
 * in-memory orphan or a half-written artifact set behind.
 */
export async function spawnDetachedTask(
  options: SpawnDetachedTaskOptions,
): Promise<SpawnDetachedTaskResult> {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawn ?? mapNodeSpawn;
  const id = options.id;
  const taskDirAbs = options.taskDirAbs;
  const outputAbsPath = join(taskDirAbs, `${id}.output`);
  const exitMarkerFile = exitMarkerPath(taskDirAbs, id);
  const wrapMode = wrapModeForDialect(options.policy.dialect);

  let runnerScriptFile: string | undefined;
  let invocation: {
    shell: string;
    args: string[];
    windowsVerbatimArguments: boolean;
  };
  if (wrapMode === 'posix') {
    invocation = {
      shell: options.policy.executable,
      args: [
        ...options.policy.argvPrefix,
        buildPosixWrappedCommand(options.command, exitMarkerFile),
      ],
      windowsVerbatimArguments: options.policy.windowsVerbatimArguments,
    };
  } else if (wrapMode === 'cmd') {
    runnerScriptFile = runnerScriptPath(taskDirAbs, id);
    await writeFileFsynced(
      runnerScriptFile,
      buildWindowsRunnerScript(options.command, exitMarkerFile),
    );
    invocation = {
      shell: options.policy.executable,
      args: [...options.policy.argvPrefix, runnerScriptFile],
      windowsVerbatimArguments: options.policy.windowsVerbatimArguments,
    };
  } else {
    // Unclassified user shell: launch unwrapped, without an exit marker.
    invocation = {
      shell: options.policy.executable,
      args: [...options.policy.argvPrefix, options.command],
      windowsVerbatimArguments: options.policy.windowsVerbatimArguments,
    };
  }

  // The child duplicates this descriptor; 'a' keeps both ends in append mode.
  const outFd = openSync(outputAbsPath, 'a', 0o666);
  const cleanup = (): void => {
    try {
      closeSync(outFd);
    } catch {
      // The descriptor may already be closed by a partial failure path.
    }
    if (runnerScriptFile !== undefined) {
      try {
        unlinkSync(runnerScriptFile);
      } catch {
        // Best effort; the task dir is swept later if this fails.
      }
      runnerScriptFile = undefined;
    }
  };

  let child: DetachedSpawnChild;
  try {
    child = spawnFn(invocation.shell, invocation.args, {
      cwd: options.cwd,
      detached: platform !== 'win32',
      stdio: ['ignore', outFd, outFd],
      env: options.env,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The launch error below remains authoritative; no pid was acquired.
    }
    cleanup();
    throw new Error('detached task spawn failed before a valid pid was acquired');
  }
  child.unref?.();
  // The child holds its own duplicated descriptor; release the parent's copy.
  closeSync(outFd);

  return {
    invocation,
    exitMarkerFile,
    exitMarkerTrusted: wrapMode !== 'none',
    runnerScriptFile,
    pid,
    posixProcessGroupId: platform === 'win32' ? undefined : pid,
  };
}

function mapNodeSpawn(command: string, args: string[], options: SpawnOptions): DetachedSpawnChild {
  return nodeSpawn(command, args, options);
}
