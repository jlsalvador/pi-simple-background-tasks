import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Windows detach helper: the task's outer process is created by the WMI
 * service (`Win32_Process.Create`), not by the extension process.
 *
 * Background-task survival on this platform requires the task to be outside
 * every process job and console session that belongs to the Pi activation:
 * children spawned directly by the Pi process die together with it (job and
 * console-session teardown), no matter how they are detached. Processes
 * created through WMI have `WmiPrvSE.exe` as their service-side parent and
 * outlive the activating process, its console, and its SSH/terminal session
 * entirely — verified end to end on Windows 11.
 *
 * The helper is a short-lived PowerShell one-shot: it performs exactly one
 * `Win32_Process.Create` and prints the new pid. It is spawned directly by the
 * extension and never survives the launch itself, so a dead activation can
 * never leave a launch in flight (failures surface as launch errors).
 */

export interface WmiHelperChild {
  readonly pid?: number | undefined;
  readonly stdout: {
    on(event: 'data', listener: (data: Buffer | string) => void): unknown;
  };
  readonly stderr: {
    on(event: 'data', listener: (data: Buffer | string) => void): unknown;
  };
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type WmiSpawnFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean },
) => WmiHelperChild;

export interface WindowsWmiSpawnOptions {
  /** Full CreateProcess command line for the new process. */
  readonly commandLine: string;
  readonly currentDirectory: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Test seam; defaults to PowerShell via SystemRoot. */
  readonly spawn?: WmiSpawnFn | undefined;
  readonly timeoutMs?: number | undefined;
}

export const WMI_CREATE_TIMEOUT_MS = 20_000;

const PS_HEADER = ['$ErrorActionPreference = "Stop"'].join('\n');

/**
 * Builds the one-shot PowerShell script: creates the process hidden, reports
 * failures as `WMIERR <ReturnValue>` on stdout, otherwise prints the pid.
 */
export function buildWindowsWmiCreateScript(commandLine: string, currentDirectory: string): string {
  return [
    PS_HEADER,
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{` +
      `CommandLine = '${escapePowerShellSingleQuoted(commandLine)}';` +
      `CurrentDirectory = '${escapePowerShellSingleQuoted(currentDirectory)}' }`,
    'if ($r.ReturnValue -ne 0) { Write-Output ("WMIERR " + $r.ReturnValue); exit 1 }',
    'Write-Output $r.ProcessId',
  ].join('\n');
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export function encodeWindowsWmiScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function powershellExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const windir = env.Windir ?? env.SYSTEMROOT ?? env.winDir ?? 'C:\\Windows';
  return join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Parses `WMIERR N` / `<pid>` helper output into either a failure or a pid. */
export function parseWmiHelperOutput(stdout: string, stderr: string): { pid: number } {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errLine = lines.find((line) => line.startsWith('WMIERR'));
  if (errLine !== undefined) {
    const code = errLine.slice('WMIERR'.length).trim();
    throw new Error(
      `Win32_Process.Create failed (ReturnValue ${code || 'unknown'})` +
        (stderr.length > 0 ? `; helper output: ${stderr.trim()}` : ''),
    );
  }
  const candidate = lines[lines.length - 1];
  const pid = candidate === undefined ? Number.NaN : Number(candidate);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(
      `Windows WMI spawn did not return a pid${stderr.length > 0 ? `; helper output: ${stderr.trim()}` : ''}`,
    );
  }
  return { pid };
}

export async function createProcessViaWmi(
  options: WindowsWmiSpawnOptions,
): Promise<{ pid: number }> {
  const spawn = options.spawn ?? defaultWmiSpawn;
  const env = options.env ?? process.env;
  const scriptFile = encodeWindowsWmiScript(
    buildWindowsWmiCreateScript(options.commandLine, options.currentDirectory),
  );
  const timeoutMs = options.timeoutMs ?? WMI_CREATE_TIMEOUT_MS;

  const child = spawn(
    powershellExecutable(env),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', scriptFile],
    {
      env,
      windowsVerbatimArguments: false,
    },
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on('data', (chunk) => stdout.push(String(chunk)));
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));

  return new Promise((resolve, reject) => {
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    let settled = false;
    let timer: NodeJS.Timeout | undefined = setTimeout(() => {
      timer = undefined;
      rejectOnce(
        new Error(
          `Windows WMI spawn exceeded ${String(Math.round(timeoutMs / 1000))}s timeout; the helper was terminated`,
        ),
      );
      try {
        child.kill('SIGKILL');
      } catch {
        // Rejection is authoritative; the helper may already have exited.
      }
    }, timeoutMs);

    const close = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const detail =
        (code === null ? 'exit signal' : `exit ${String(code)}`) + tailOutput(stderr.join(''));
      if (code !== 0) {
        reject(new Error(`Windows WMI helper failed (${detail})`));
        return;
      }
      try {
        resolve(parseWmiHelperOutput(stdout.join(''), stderr.join('')));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    child.on('error', (error: Error) =>
      rejectOnce(new Error(`Windows WMI helper failed to start: ${error.message}`)),
    );
    child.on('close', (code: number | null) => close(code));
  });
  function tailOutput(stderrText: string): string {
    const normalized = stderrText.trim();
    return normalized.length === 0 ? '' : `; helper output: ${normalized}`;
  }
}

function defaultWmiSpawn(
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean },
): WmiHelperChild {
  return nodeSpawn(file, args, {
    env: options.env,
    windowsVerbatimArguments: false,
  }) as unknown as WmiHelperChild;
}
