export const PI_BG_DOCK_SHORTCUT_VALUES = Object.freeze([
  'shift+down',
  'ctrl+alt+b',
  'off',
] as const);
export type PiBackgroundDockShortcut = (typeof PI_BG_DOCK_SHORTCUT_VALUES)[number];

export const PI_BG_DEFAULT_DOCK_SHORTCUT: PiBackgroundDockShortcut = 'shift+down';

export interface PiBackgroundConfig {
  readonly dockShortcut: PiBackgroundDockShortcut;
}

const CONFIG_VALUE_EXCERPT_CHARS = 96;

function boundedConfigValue(value: string): string {
  if (value.length <= CONFIG_VALUE_EXCERPT_CHARS) return JSON.stringify(value);
  return `${JSON.stringify(value.slice(0, CONFIG_VALUE_EXCERPT_CHARS))}… (${String(value.length)} chars)`;
}

function invalidConfig(variable: string, reason: string, value: string): never {
  throw new Error(
    `pi_bg_config_invalid: ${variable} ${reason}; received ${boundedConfigValue(value)}`,
  );
}

function parseDockShortcut(rawValue: string | undefined): PiBackgroundDockShortcut {
  const raw = rawValue ?? PI_BG_DEFAULT_DOCK_SHORTCUT;
  if (!(PI_BG_DOCK_SHORTCUT_VALUES as readonly string[]).includes(raw)) {
    invalidConfig(
      'PI_BG_DOCK_SHORTCUT',
      `accepted values are exactly ${PI_BG_DOCK_SHORTCUT_VALUES.join(',')}`,
      raw,
    );
  }
  return raw as PiBackgroundDockShortcut;
}

export function parseBackgroundTasksConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PiBackgroundConfig {
  const dockShortcut = parseDockShortcut(env['PI_BG_DOCK_SHORTCUT']);
  return Object.freeze({ dockShortcut });
}

export function dockShortcutFooterHint(shortcut: PiBackgroundDockShortcut): string {
  if (shortcut === 'shift+down') return 'Shift↓';
  if (shortcut === 'ctrl+alt+b') return 'CtrlAltB';
  return '/tasks';
}
