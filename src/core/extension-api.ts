import type { EventBus } from '@earendil-works/pi-coding-agent';
import type { BgTaskSnapshot } from './common.js';
import type { BackgroundTaskRegistry } from './registry.js';

export const BG_TERMINAL_CHANNEL = 'pi-background-tasks:terminal:v1';
export const BG_TERMINAL_SCHEMA = 'pi-background-tasks.extension-terminal.v1';
export const BG_EXTENSION_SERVICE_CLOSED_CODE = 'pi_background_tasks_eventbus_closed';

export type BackgroundTaskExtensionServiceState = 'open' | 'closed';

export class BackgroundTaskExtensionServiceClosedError extends Error {
  readonly code = BG_EXTENSION_SERVICE_CLOSED_CODE;

  constructor() {
    super('pi-background-tasks EventBus service is closed');
    this.name = 'BackgroundTaskExtensionServiceClosedError';
  }
}

export interface BackgroundTaskExtensionTerminal {
  schema_version: typeof BG_TERMINAL_SCHEMA;
  task: BgTaskSnapshot;
}

export interface BackgroundTaskExtensionService {
  readonly state: BackgroundTaskExtensionServiceState;
  publishTerminal(task: BgTaskSnapshot): void;
  close(): void;
}

export interface BackgroundTaskExtensionServiceOptions {
  events: EventBus;
  registry: BackgroundTaskRegistry;
}

class InstalledBackgroundTaskExtensionService implements BackgroundTaskExtensionService {
  private readonly events: EventBus;
  private readonly registry: BackgroundTaskRegistry;
  private serviceState: BackgroundTaskExtensionServiceState = 'open';

  constructor(options: BackgroundTaskExtensionServiceOptions) {
    this.events = options.events;
    this.registry = options.registry;
  }

  get state(): BackgroundTaskExtensionServiceState {
    return this.serviceState;
  }

  publishTerminal(task: BgTaskSnapshot): void {
    if (this.serviceState === 'closed') throw new BackgroundTaskExtensionServiceClosedError();
    const terminal: BackgroundTaskExtensionTerminal = {
      schema_version: BG_TERMINAL_SCHEMA,
      task,
    };
    this.events.emit(BG_TERMINAL_CHANNEL, terminal);
  }

  close(): void {
    if (this.serviceState === 'closed') return;
    this.serviceState = 'closed';
    this.registry.closeTerminalPublication('publisher_closed');
  }
}

export function installBackgroundTaskExtensionApi(
  options: BackgroundTaskExtensionServiceOptions,
): BackgroundTaskExtensionService {
  return new InstalledBackgroundTaskExtensionService(options);
}
