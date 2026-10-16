/**
 * Activation-local synchronous close barrier. Every registered callback runs on
 * close(), in registration order, and a throwing callback does not prevent the
 * later ones (failures are aggregated). Used to close every lazy lane on the same
 * call stack during a Pi reload or shutdown.
 */
export class SynchronousActivationCloseFence {
  private closed = false;
  private readonly callbacks = new Set<() => void>();

  add(callback: () => void): void {
    this.callbacks.add(callback);
    if (this.closed) callback();
  }

  close(): void {
    this.closed = true;
    const failures: unknown[] = [];
    for (const callback of this.callbacks) {
      try {
        callback();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `close barrier failed in ${failures.length} callback(s)`);
    }
  }
}

/**
 * Activation-local single-flight memo for one deferred import. The module loads
 * once on the first `run` and every later call reuses the same promise. After
 * `close()` (a Pi reload or shutdown) a racing `run` is rejected so the stale
 * activation never touches the freshly reloaded runtime.
 */
export class LazyModule<T> {
  private module: Promise<T> | undefined;
  private closed = false;

  constructor(private readonly importer: () => Promise<T>) {}

  close(): void {
    this.closed = true;
  }

  async run<R>(operation: (module: T) => R | Promise<R>): Promise<R> {
    if (this.closed) throw new Error('activation closed');
    this.module ??= this.importer();
    const value = await this.module;
    if (this.closed) throw new Error('activation closed');
    return operation(value);
  }
}
