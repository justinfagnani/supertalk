/**
 * @fileoverview SignalHandler - Coordinates signal state between sender and receiver.
 *
 * The SignalHandler handles:
 * - Watching signals on the sender side
 * - Sending batch updates when signals change
 * - Receiving batch updates and dispatching to RemoteSignals
 *
 * Usage:
 * ```ts
 * // Both sides
 * const signalHandler = new SignalHandler();
 * const options = { handlers: [signalHandler] };
 *
 * // Expose/wrap with the handler
 * expose(service, endpoint, options);
 * const remote = await wrap<Service>(endpoint, options);
 * ```
 */

import {Signal} from 'signal-polyfill';
import {WIRE_TYPE} from '@supertalk/core';
import type {
  Handler,
  HandlerConnectionContext,
  ToWireContext,
  FromWireContext,
  WireValue,
} from '@supertalk/core';
import {RemoteSignal} from './remote-signal.js';
import type {AnySignal, WireSignal, SignalBatchUpdate} from './types.js';
import {
  isSignalBatchUpdate,
  isSignalReleaseMessage,
  SIGNAL_WIRE_TYPE,
} from './types.js';

/**
 * Handler for signal synchronization across a connection.
 *
 * Create one SignalHandler and include it in your handlers array for both
 * expose() and wrap().
 *
 * Note: This handler is asymmetric - canHandle checks for Signal.State/Computed
 * on the sender, but fromWire returns RemoteSignal on the receiver. We cast to
 * work around the type system limitation.
 */
export class SignalHandler implements Handler<AnySignal, WireSignal> {
  readonly wireType = SIGNAL_WIRE_TYPE;

  // Connection context provided by core
  #ctx: HandlerConnectionContext | undefined;

  // Sender side: signals we've sent, indexed by ID
  #nextSignalId = 1;
  #sentSignals = new Map<number, AnySignal>();
  #signalToId = new WeakMap<AnySignal, number>();
  #watcher: Signal.subtle.Watcher | undefined;
  #flushScheduled = false;

  // Private wrapper Computeds - only we read these, so getPending() reliably
  // returns them even if the underlying signal was read elsewhere.
  #signalWrappers = new Map<number, Signal.Computed<unknown>>();

  // Receiver side: RemoteSignals we've created, indexed by ID
  #remoteSignals = new Map<number, WeakRef<RemoteSignal<unknown>>>();
  #remoteCleanup = new FinalizationRegistry((signalId: number) => {
    this.#remoteSignals.delete(signalId);
    // Send release message through handler messaging
    this.#ctx?.sendMessage({type: 'signal:release', signalId});
  });

  /**
   * Called by core when the connection is established.
   */
  connect(ctx: HandlerConnectionContext): void {
    this.#ctx = ctx;
  }

  /**
   * Called by core when a handler message is received.
   */
  onMessage(payload: unknown): void {
    if (isSignalBatchUpdate(payload)) {
      this.#handleBatchUpdate(payload);
    } else if (isSignalReleaseMessage(payload)) {
      this.releaseSignal(payload.signalId);
    }
  }

  /**
   * Called by core when the connection is closed.
   */
  disconnect(): void {
    this.#ctx = undefined;
    if (this.#watcher !== undefined) {
      this.#watcher.unwatch(...this.#signalWrappers.values());
    }
    this.#sentSignals.clear();
    this.#signalWrappers.clear();
    this.#remoteSignals.clear();
  }

  canHandle(value: unknown): value is AnySignal {
    return value instanceof Signal.State || value instanceof Signal.Computed;
  }

  toWire(signal: AnySignal, ctx: ToWireContext): WireSignal {
    return this.#sendSignal(signal, ctx);
  }

  // Return type is `unknown` because on the receiver side we return RemoteSignal,
  // not AnySignal. The Handler<T,W> type expects T but this handler is asymmetric.
  fromWire(wire: WireSignal, ctx: FromWireContext): AnySignal {
    return this.#receiveSignal(wire, ctx) as unknown as AnySignal;
  }

  /**
   * Handle sending a signal (sender side).
   */
  #sendSignal(signal: AnySignal, ctx: ToWireContext): WireSignal {
    // Check if we've already sent this signal
    let signalId = this.#signalToId.get(signal);
    if (signalId === undefined) {
      // New signal - register it
      signalId = this.#nextSignalId++;
      this.#sentSignals.set(signalId, signal);
      this.#signalToId.set(signal, signalId);

      // Wrap in a private Computed for reliable change detection.
      //
      // getPending() returns Computeds that are invalidated but not yet read.
      // If we watched the user's signal directly and someone else read it before
      // our flush, it would no longer be pending. By wrapping in our own Computed
      // that only we read, we have a private "dirty" flag that stays set until
      // we explicitly read it in #flush.
      const watcher = this.#ensureWatcher();
      const wrapper = new Signal.Computed(() => signal.get());
      this.#signalWrappers.set(signalId, wrapper);
      watcher.watch(wrapper);
      // Read the wrapper to establish the subscription
      wrapper.get();
    }

    // Serialize the current value
    const value = ctx.toWire(signal.get());

    return {
      [WIRE_TYPE]: SIGNAL_WIRE_TYPE,
      signalId,
      value,
    } as WireSignal;
  }

  /**
   * Handle receiving a signal (receiver side).
   */
  #receiveSignal(
    wire: WireSignal,
    ctx: FromWireContext,
  ): RemoteSignal<unknown> {
    // Check if we already have this signal (via WeakRef)
    const existingRef = this.#remoteSignals.get(wire.signalId);
    const existing = existingRef?.deref();
    if (existing !== undefined) {
      return existing;
    }

    // Deserialize the initial value through the context to handle nested proxies
    const initialValue = ctx.fromWire(wire.value as WireValue);

    // Create new RemoteSignal with initial value
    const remote = new RemoteSignal(wire.signalId, initialValue);
    this.#remoteSignals.set(wire.signalId, new WeakRef(remote));
    this.#remoteCleanup.register(remote, wire.signalId);
    return remote;
  }

  /**
   * Ensure the watcher is created and return it.
   */
  #ensureWatcher(): Signal.subtle.Watcher {
    return (this.#watcher ??= new Signal.subtle.Watcher(() => {
      // Watcher callback - schedule a flush
      if (!this.#flushScheduled) {
        this.#flushScheduled = true;
        queueMicrotask(this.#flush);
      }
    }));
  }

  /**
   * Flush pending signal updates.
   */
  #flush = (): void => {
    this.#flushScheduled = false;

    if (this.#watcher === undefined || this.#ctx === undefined) {
      return;
    }

    // Get all pending (dirty) wrapper computeds
    const pending = this.#watcher.getPending();

    // Collect updates for signals we've sent
    const updates: Array<{signalId: number; value: unknown}> = [];
    for (const wrapper of pending) {
      // Find which signal this wrapper belongs to
      for (const [signalId, w] of this.#signalWrappers) {
        if (w === wrapper) {
          const signal = this.#sentSignals.get(signalId);
          if (signal !== undefined) {
            // Re-evaluate the wrapper to get its new value
            // and clear its dirty flag
            const value: unknown = wrapper.get();
            updates.push({signalId, value});
          }
          break;
        }
      }
    }

    // Re-watch to continue tracking
    this.#watcher.watch();

    // Send batch update if there are any
    if (updates.length > 0) {
      const message: SignalBatchUpdate = {
        type: 'signal:batch',
        updates,
      };
      this.#ctx.sendMessage(message);
    }
  };

  /**
   * Handle a batch update from the sender.
   */
  #handleBatchUpdate(message: SignalBatchUpdate): void {
    for (const update of message.updates) {
      const ref = this.#remoteSignals.get(update.signalId);
      const remote = ref?.deref();
      if (remote !== undefined) {
        remote._update(update.value);
      }
    }
  }

  /**
   * Release a signal by ID (called when remote releases).
   * @internal
   */
  releaseSignal(signalId: number): void {
    const wrapper = this.#signalWrappers.get(signalId);
    if (wrapper !== undefined) {
      this.#watcher?.unwatch(wrapper);
      this.#signalWrappers.delete(signalId);
    }
    this.#sentSignals.delete(signalId);
    // Note: WeakMap entry will be GC'd automatically
  }

  /**
   * Get the number of sent signals being tracked (for testing).
   * @internal
   */
  get _sentSignalCount(): number {
    return this.#sentSignals.size;
  }

  /**
   * Get the number of remote signals being tracked (for testing).
   * @internal
   */
  get _remoteSignalCount(): number {
    return this.#remoteSignals.size;
  }

  /**
   * Check if a signal ID is being watched (for testing).
   * @internal
   */
  _isWatching(signalId: number): boolean {
    return this.#signalWrappers.has(signalId);
  }
}
