/**
 * @fileoverview RemoteSignal - A read-only signal that receives updates from a sender.
 *
 * RemoteSignal wraps a local Signal.State and exposes only read access.
 * Updates come from the sender via the update() method.
 *
 * The RemoteSignal uses Signal.subtle.watched/unwatched callbacks to lazily
 * request watching on the sender side. This allows signals with watched callbacks
 * on the sender to not start their work until something on the receiver actually
 * observes the signal.
 */

import {Signal} from 'signal-polyfill';

/**
 * Callback for watch state changes on a RemoteSignal.
 * @internal
 */
export type WatchStateCallback = (signalId: number, watching: boolean) => void;

/**
 * A read-only signal that represents a signal on the sender side.
 *
 * The receiver can read the value synchronously via `get()`, but cannot
 * write to it. Writes throw an error.
 *
 * The signal lazily subscribes to updates - the sender only starts watching
 * the source signal when something on the receiver side observes this
 * RemoteSignal (e.g., via an effect or computed).
 *
 * @example
 * ```ts
 * // Receiver side
 * const count = await remote.count;  // RemoteSignal<number>
 * console.log(count.get());  // 0 (initial value available synchronously)
 *
 * effect(() => {
 *   console.log('Count:', count.get());  // Reactive! Sender starts watching here.
 * });
 * ```
 */
export class RemoteSignal<T> {
  /**
   * Internal state signal that holds the current value.
   * We use Signal.State internally so effects can track this signal.
   * This signal has watched/unwatched callbacks to notify the handler.
   */
  readonly #state: Signal.State<T>;

  /**
   * The signal ID used for wire protocol.
   */
  readonly #signalId: number;

  /**
   * Callback to notify the handler of watch state changes.
   */
  #onWatchStateChange: WatchStateCallback | undefined;

  constructor(
    signalId: number,
    initialValue: T,
    onWatchStateChange?: WatchStateCallback,
  ) {
    this.#signalId = signalId;
    this.#onWatchStateChange = onWatchStateChange;

    // Create the state with watched/unwatched callbacks
    this.#state = new Signal.State(initialValue, {
      [Signal.subtle.watched]: () => {
        this.#onWatchStateChange?.(this.#signalId, true);
      },
      [Signal.subtle.unwatched]: () => {
        this.#onWatchStateChange?.(this.#signalId, false);
      },
    });
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
