/**
 * @fileoverview RemoteSignal - A read-only signal that receives updates from a sender.
 *
 * RemoteSignal wraps a local Signal.State and exposes only read access.
 * Updates come from the sender via the update() method.
 */

import {Signal} from 'signal-polyfill';

/**
 * A read-only signal that represents a signal on the sender side.
 *
 * The receiver can read the value synchronously via `get()`, but cannot
 * write to it. Writes throw an error.
 *
 * @example
 * ```ts
 * // Receiver side
 * const count = await remote.count;  // RemoteSignal<number>
 * console.log(count.get());  // 0 (initial value available synchronously)
 *
 * effect(() => {
 *   console.log('Count:', count.get());  // Reactive!
 * });
 * ```
 */
export class RemoteSignal<T> {
  /**
   * Internal state signal that holds the current value.
   * We use Signal.State internally so effects can track this signal.
   */
  readonly #state: Signal.State<T>;

  /**
   * The signal ID used for wire protocol.
   */
  readonly #signalId: number;

  constructor(signalId: number, initialValue: T) {
    this.#signalId = signalId;
    this.#state = new Signal.State(initialValue);
  }

  /**
   * Get the current value of the signal.
   * This is reactive - effects will track this read.
   */
  get(): T {
    return this.#state.get();
  }

  /**
   * Throws an error - remote signals are read-only.
   */
  set(_value: T): void {
    throw new Error(
      'RemoteSignal is read-only. The signal can only be modified on the sender side.',
    );
  }

  /**
   * The signal ID for wire protocol.
   * @internal
   */
  get signalId(): number {
    return this.#signalId;
  }

  /**
   * Update the value from a wire update.
   * @internal Called by the signal handler when an update is received.
   */
  _update(value: T): void {
    this.#state.set(value);
  }
}
