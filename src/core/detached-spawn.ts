import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type ResolvedShellPolicy, shellQuote } from './common.js';
import { writeFileFsynced } from './task-durable.js';
import { createProcessViaWmi } from './windows-wmi-spawn.js';

/**
 * Detached background-task spawning: the single launch path used by every task.
 *
 * The extension process never owns the child at runtime. There are no pipes, no
 * in-process output stream, and no handle that a same-process /reload could
 * lose. The ownership facts live outside the extension:
 *
 * - POSIX: the child starts fully detached, so it leads its own process group
 *   (`pgid === pid`) and signal authority is `-pgid`, valid from any process.
 * - Windows: the outer process is created by the WMI service, so the task is
 *   outside every process job and console session owned by the Pi activation
 *   and outlives it (restart, /reload-style reattachments, even a hard kill).
 *   Ownership of the tree is `taskkill /T /F` via the recorded pid. Output is
 *   redirected by the spawn's own command line (the extension holds no fd).
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
 *
 * The user command runs under a nested `cmd /d /s /c "<command>"` instead of
 * directly in the runner: a bare `exit N` in the user command terminates the
 * whole cmd instance and would skip the epilogue lines entirely, while a
 * nested instance only sets the errorlevel for the runner to record. The
 * quoting follows the same `/s /c "<command>"` contract as
 * `shellInvocationForPolicy`, arg-for-arg.
 */
export function buildWindowsRunnerScript(
  command: string,
  exitMarkerFile: string,
  shellExecutable: string,
): string {
  return [
    '@echo off',
    `"${shellExecutable}" /d /s /c "${command}"`,
    `(echo %errorlevel%)>"${exitMarkerFile}"`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
}

/**
 * The WMI-created process runs its command under `cmd /d /s /c "..."`; the
 * redirection is part of that single /c string, so the extension does not need
 * to hold output file descriptors (the child writes the file directly).
 *
 * `cmd /s` keeps the outermost quote pair: it strips the first and last quote
 * of the /c argument, leaving `<body> 1>"<output>" 2>&1` for command parsing.
 * A bare `exit N` in the user command therefore still reaches the epilogue
 * through the runner's nested cmd.
 */
export function buildWindowsWmiCommandLine(body: string, outputAbsPath: string): string {
  return `cmd.exe /d /s /c "${body} 1>"${outputAbsPath}" 2>&1"`;
}

/**
 * Body for a wrapped cmd task: one quoted token pointing at the runner file.
 * The runner script carries the user command and the epilogue.
 */
export function buildWindowsRunnerBody(runnerScriptFile: string): string {
  return `"${runnerScriptFile}"`;
}

/** True for dialects the wrapper understands; 'none' loses exact exit codes. */
export function wrapModeForDialect(dialect: ResolvedShellPolicy['dialect']): DetachedWrapMode {
  if (dialect === 'posix' || dialect === 'bash') return 'posix';
  if (dialect === 'cmd') return 'cmd';
  return 'none';
}

/**
 * Launch one detached task. Failures clean up every artifact before an error
 * is thrown, so the caller's failure path never sees a half-written task.
 */
export async function spawnDetachedTask(
  options: SpawnDetachedTaskOptions,
): Promise<SpawnDetachedTaskResult> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return spawnWindowsDetachedTask(options);
  return spawnPosixDetachedTask(options);
}

/**
 * Windows: everything goes through the WMI service so the task outlives its
 * creating process. The runner script (with the exit-marker epilogue) and the
 * one-shot WMI helper clean up on any launch failure.
 */
async function spawnWindowsDetachedTask(
  options: SpawnDetachedTaskOptions,
): Promise<SpawnDetachedTaskResult> {
  const id = options.id;
  const taskDirAbs = options.taskDirAbs;
  const outputAbsPath = join(taskDirAbs, `${id}.output`);
  const exitMarkerFile = exitMarkerPath(taskDirAbs, id);
  const wrapMode = wrapModeForDialect(options.policy.dialect);

  let runnerScriptFile: string | undefined;
  let commandLine: string;
  if (wrapMode === 'none') {
    // Unclassified user shell: launch it verbatim under cmd, without an exit
    // marker; the redirection still writes the task output.
    const args = [...options.policy.argvPrefix, options.command];
    commandLine = buildWindowsWmiCommandLine(
      `${quoteWinArg(options.policy.executable)} ${args.join(' ')}`,
      outputAbsPath,
    );
  } else {
    // 'cmd' (and defensively any wrapped dialect): the runner file carries the
    // user command plus the exit-marker epilogue.
    runnerScriptFile = runnerScriptPath(taskDirAbs, id);
    await writeFileFsynced(
      runnerScriptFile,
      buildWindowsRunnerScript(options.command, exitMarkerFile, options.policy.executable),
    );
    commandLine = buildWindowsWmiCommandLine(
      buildWindowsRunnerBody(runnerScriptFile),
      outputAbsPath,
    );
  }

  const sweepRunner = (): void => {
    if (runnerScriptFile === undefined) return;
    try {
      unlinkSync(runnerScriptFile);
    } catch {
      // Best effort; the task dir is swept later if this fails.
    }
    runnerScriptFile = undefined;
  };

  let pid: number;
  try {
    const result = await createProcessViaWmi({
      commandLine,
      currentDirectory: options.cwd,
      env: options.env,
    });
    pid = result.pid;
  } catch (error) {
    sweepRunner();
    throw error;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    sweepRunner();
    throw new Error('detached task spawn failed before a valid pid was acquired');
  }

  return {
    exitMarkerFile,
    exitMarkerTrusted: wrapMode !== 'none',
    runnerScriptFile,
    pid,
    posixProcessGroupId: undefined,
  };
}

/**
 * POSIX: spawn detached with the output file opened directly. The child leads
 * its own process group, so `-pgid` kills remain authoritative from any
 * process (the recorded `pgid === pid` is the ownership contract).
 */
async function spawnPosixDetachedTask(
  options: SpawnDetachedTaskOptions,
): Promise<SpawnDetachedTaskResult> {
  const spawnFn = options.spawn ?? mapNodeSpawn;
  const id = options.id;
  const taskDirAbs = options.taskDirAbs;
  const outputAbsPath = join(taskDirAbs, `${id}.output`);
  const exitMarkerFile = exitMarkerPath(taskDirAbs, id);
  const wrapMode = wrapModeForDialect(options.policy.dialect);

  const invocation =
    wrapMode === 'posix'
      ? {
          shell: options.policy.executable,
          args: [
            ...options.policy.argvPrefix,
            buildPosixWrappedCommand(options.command, exitMarkerFile),
          ],
          windowsVerbatimArguments: options.policy.windowsVerbatimArguments,
        }
      : {
          // Unclassified user shell: launch unwrapped, without an exit marker.
          shell: options.policy.executable,
          args: [...options.policy.argvPrefix, options.command],
          windowsVerbatimArguments: options.policy.windowsVerbatimArguments,
        };

  // The child duplicates this descriptor; 'a' keeps both ends in append mode.
  const outFd = openSync(outputAbsPath, 'a', 0o666);
  const cleanup = (): void => {
    try {
      closeSync(outFd);
    } catch {
      // The descriptor may already be closed by a partial failure path.
    }
  };

  let child: DetachedSpawnChild;
  try {
    child = spawnFn(invocation.shell, invocation.args, {
      cwd: options.cwd,
      detached: true,
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
    exitMarkerFile,
    exitMarkerTrusted: wrapMode !== 'none',
    pid,
    posixProcessGroupId: pid,
  };
}

/** Quotes one token for a raw CreateProcess command line (no shell here). */
function quoteWinArg(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function mapNodeSpawn(command: string, args: string[], options: SpawnOptions): DetachedSpawnChild {
  return nodeSpawn(command, args, options);
}
