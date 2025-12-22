/**
 * Test utilities for @supertalk/signals (in-process, MessageChannel-based).
 *
 * WARNING: These utilities run both sides in the same thread with a shared
 * signal graph. This is fine for:
 * - Unit tests of RemoteSignal
 * - Basic transfer tests
 * - Fast iteration during development
 *
 * For testing signal isolation and update propagation, use the worker-based
 * utilities in worker-utils.ts instead.
 */

import {MessageChannel, type MessagePort} from 'node:worker_threads';
import {expose, wrap} from '@supertalk/core';
import type {Remote, Options} from '@supertalk/core';
import {SignalManager} from '../../index.js';

/**
 * A disposable test context that sets up a service and remote proxy with signal support.
 */
export interface SignalServiceContext<R> {
  /** The wrapped remote proxy for calling the service */
  remote: R;
  /** Signal manager for the sender (expose) side */
  senderManager: SignalManager;
  /** Signal manager for the receiver (wrap) side */
  receiverManager: SignalManager;
  /** The underlying ports (exposed for advanced use cases) */
  port1: MessagePort;
  port2: MessagePort;
  /** Dispose method for `using` declarations */
  [Symbol.dispose]: () => void;
}

/**
 * Set up a service with signal support and return a remote proxy for testing.
 * Use with `using` to automatically close ports when the scope ends.
 *
 * @example
 * ```ts
 * using ctx = setupSignalService({
 *   get count() { return countSignal; }
 * });
 * const count = await ctx.remote.count;
 * // ports are automatically closed when ctx goes out of scope
 * ```
 */
export function setupSignalService<T extends object>(
  service: T,
  options: Omit<Options, 'handlers'> = {},
): SignalServiceContext<Remote<T>> {
  const {port1, port2} = new MessageChannel();

  // Create signal managers for both sides
  const senderManager = new SignalManager(port1);
  const receiverManager = new SignalManager(port2);

  // Expose with signal handler
  expose(service, port1, {
    ...options,
    handlers: [senderManager.handler, ...((options as Options).handlers ?? [])],
  });

  // Wrap with signal handler
  const remote = wrap<T>(port2, {
    ...options,
    handlers: [
      receiverManager.handler,
      ...((options as Options).handlers ?? []),
    ],
  });

  return {
    remote,
    senderManager,
    receiverManager,
    port1,
    port2,
    [Symbol.dispose]() {
      senderManager.dispose();
      receiverManager.dispose();
      port1.close();
      port2.close();
    },
  };
}

/**
 * Wait for the next microtask to flush.
 */
export function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

/**
 * Wait for N microtasks (useful for letting batched updates propagate).
 */
export async function waitMicrotasks(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) {
    await nextMicrotask();
  }
}
