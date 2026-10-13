import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';

export const PI_BG_DOCK_SHORTCUT_VALUES = Object.freeze([
  'shift+down',
  'ctrl+alt+b',
  'off',
] as const);
export type PiBackgroundDockShortcut = (typeof PI_BG_DOCK_SHORTCUT_VALUES)[number];

export const PI_BG_DEFAULT_DOCK_SHORTCUT: PiBackgroundDockShortcut = 'shift+down';

/** Config file name this extension reads, following the PI extension-config pattern. */
export const PI_BG_CONFIG_FILE_NAME = 'pi-background-tasks.json';

export interface PiBackgroundConfig {
  readonly tasksDir: string;
  readonly dockShortcut: PiBackgroundDockShortcut;
}

interface BackgroundTasksConfigFile {
  readonly tasksDir?: string;
  readonly dockShortcut?: PiBackgroundDockShortcut;
}

/** Default tasks directory: the PI agent directory plus `tasks`. */
export function defaultTasksDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, 'tasks');
}

function configError(file: string, reason: string): never {
  throw new Error(`pi_bg_config_invalid: ${file} ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConfigFile(file: string): BackgroundTasksConfigFile | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    configError(file, `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) configError(file, 'must contain a JSON object');
  const unknown = Object.keys(parsed).filter((key) => key !== 'tasksDir' && key !== 'dockShortcut');
  if (unknown.length > 0) configError(file, `contains unknown keys: ${unknown.join(', ')}`);
  if (parsed['tasksDir'] !== undefined && typeof parsed['tasksDir'] !== 'string')
    configError(file, 'has a non-string tasksDir');
  if (
    parsed['dockShortcut'] !== undefined &&
    !(PI_BG_DOCK_SHORTCUT_VALUES as readonly string[]).includes(parsed['dockShortcut'] as string)
  )
    configError(
      file,
      `has an invalid dockShortcut; accepted values are exactly ${PI_BG_DOCK_SHORTCUT_VALUES.join(',')}`,
    );
  return parsed as BackgroundTasksConfigFile;
}

function resolveTasksDir(raw: string, configFileDir: string): string {
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(configFileDir, expanded);
}

/**
 * Resolve extension configuration following the PI extension-config pattern:
 * the global file under `<agent-dir>/extensions/` plus a project file under
 * `<cwd>/.pi/`; project keys override global keys. Absent keys keep their
 * defaults.
 */
export function resolveBackgroundTasksConfig(
  cwd: string,
  agentDir: string = getAgentDir(),
): PiBackgroundConfig {
  const files: Array<{ file: string; dir: string }> = [
    { file: join(agentDir, 'extensions', PI_BG_CONFIG_FILE_NAME), dir: agentDir },
    { file: join(cwd, CONFIG_DIR_NAME, PI_BG_CONFIG_FILE_NAME), dir: cwd },
  ];
  let tasksDir: string | undefined;
  let dockShortcut = PI_BG_DEFAULT_DOCK_SHORTCUT;
  for (const { file, dir } of files) {
    const parsed = readConfigFile(file);
    if (parsed === undefined) continue;
    if (parsed.tasksDir !== undefined) tasksDir = resolveTasksDir(parsed.tasksDir, dir);
    if (parsed.dockShortcut !== undefined) dockShortcut = parsed.dockShortcut;
  }
  return Object.freeze({
    tasksDir: tasksDir ?? defaultTasksDir(agentDir),
    dockShortcut,
  });
}

export function dockShortcutFooterHint(shortcut: PiBackgroundDockShortcut): string {
  if (shortcut === 'shift+down') return 'Shift↓';
  if (shortcut === 'ctrl+alt+b') return 'CtrlAltB';
  return '/tasks';
}
