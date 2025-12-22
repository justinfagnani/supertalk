/**
 * @fileoverview SignalManager - Coordinates signal state between sender and receiver.
 *
 * The SignalManager handles:
 * - Watching signals on the sender side
 * - Sending batch updates when signals change
 * - Receiving batch updates and dispatching to RemoteSignals
 *
 * Usage:
 * ```ts
 * // Both sides
 * const manager = new SignalManager(endpoint);
 * const options = { handlers: [manager.handler] };
 *
 * // Expose/wrap with the handler
 * expose(service, endpoint, options);
 * const remote = await wrap<Service>(endpoint, options);
 * ```
 */

import {Signal} from 'signal-polyfill';
import {WIRE_TYPE} from '@supertalk/core';
import type {
  Endpoint,
  Handler,
  ToWireContext,
  FromWireContext,
} from '@supertalk/core';
import {RemoteSignal} from './remote-signal.js';
import type {AnySignal, WireSignal, SignalBatchUpdate} from './types.js';
import {isSignalBatchUpdate, SIGNAL_WIRE_TYPE} from './types.js';

/**
 * Manages signal synchronization across a connection.
 *
 * Create one SignalManager per endpoint. Use `manager.handler` in your
 * handlers array for both expose() and wrap().
 */
export class SignalManager {
  readonly #endpoint: Endpoint;

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
  #remoteSignals = new Map<number, RemoteSignal<unknown>>();

  // Message handler reference for cleanup
  #messageHandler: (event: MessageEvent) => void;

  /**
   * The handler to use with expose() and wrap().
   *
   * Note: The handler type is `Handler<AnySignal, WireSignal>` which means
   * canHandle accepts AnySignal. However, fromWire returns RemoteSignal which
   * is not an AnySignal. This is intentional - the sender sends signals,
   * the receiver gets RemoteSignals. We cast to work around the type system.
   */
  readonly handler: Handler<AnySignal, WireSignal>;

  constructor(endpoint: Endpoint) {
    this.#endpoint = endpoint;

    // Set up message listener for batch updates
    this.#messageHandler = this.#onMessage.bind(this);
    endpoint.addEventListener('message', this.#messageHandler);

    // Create the handler
    // We use `as Handler<AnySignal, WireSignal>` because the handler is
    // asymmetric: canHandle checks for Signal.State/Computed on sender,
    // but fromWire returns RemoteSignal on receiver.
    this.handler = {
      wireType: SIGNAL_WIRE_TYPE,

      canHandle: (value: unknown): value is AnySignal => {
        return (
          value instanceof Signal.State || value instanceof Signal.Computed
        );
      },

      toWire: (signal: AnySignal, ctx: ToWireContext): WireSignal => {
        return this.#sendSignal(signal, ctx);
      },

      fromWire: (wire: WireSignal, _ctx: FromWireContext): unknown => {
        return this.#receiveSignal(wire);
      },
    } as Handler<AnySignal, WireSignal>;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.#endpoint.removeEventListener('message', this.#messageHandler);
    if (this.#watcher !== undefined) {
      this.#watcher.unwatch(...this.#signalWrappers.values());
    }
    this.#sentSignals.clear();
    this.#signalWrappers.clear();
    this.#remoteSignals.clear();
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
  #receiveSignal(wire: WireSignal): RemoteSignal<unknown> {
    // Check if we already have this signal
    let remote = this.#remoteSignals.get(wire.signalId);
    if (remote === undefined) {
      // Create new RemoteSignal with initial value
      remote = new RemoteSignal(wire.signalId, wire.value);
      this.#remoteSignals.set(wire.signalId, remote);
    }
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

    if (this.#watcher === undefined) {
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
      this.#endpoint.postMessage(message);
    }
  };

  /**
   * Handle incoming messages.
   */
  #onMessage(event: MessageEvent): void {
    const data = event.data as unknown;
    if (isSignalBatchUpdate(data)) {
      this.#handleBatchUpdate(data);
    }
  }

  /**
   * Handle a batch update from the sender.
   */
  #handleBatchUpdate(message: SignalBatchUpdate): void {
    for (const update of message.updates) {
      const remote = this.#remoteSignals.get(update.signalId);
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
}
