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
import {SignalHandler} from '../../index.js';
import type {SignalHandlerOptions} from '../../index.js';

/**
 * A disposable test context that sets up a service and remote proxy with signal support.
 */
export interface SignalServiceContext<R> {
  /** The wrapped remote proxy for calling the service */
  remote: R;
  /** Signal handler for the sender (expose) side */
  senderHandler: SignalHandler;
  /** Signal handler for the receiver (wrap) side */
  receiverHandler: SignalHandler;
  /** The underlying ports (exposed for advanced use cases) */
  port1: MessagePort;
  port2: MessagePort;
  /** Dispose method for `using` declarations */
  [Symbol.dispose]: () => void;
}

/**
 * Options for setupSignalService.
 */
export interface SetupSignalServiceOptions extends Omit<Options, 'handlers'> {
  /** Options to pass to SignalHandler on both sides */
  signalHandlerOptions?: SignalHandlerOptions;
}

/**
 * Set up a service with signal support and return a remote proxy for testing.
 * Use with `await using` to automatically close ports when the scope ends.
 *
 * @example
 * ```ts
 * await using ctx = await setupSignalService({
 *   get count() { return countSignal; }
 * });
 * const count = await ctx.remote.count;
 * // ports are automatically closed when ctx goes out of scope
 * ```
 */
export async function setupSignalService<T extends object>(
  service: T,
  options: SetupSignalServiceOptions = {},
): Promise<SignalServiceContext<Remote<T>>> {
  const {port1, port2} = new MessageChannel();
  const {signalHandlerOptions, ...coreOptions} = options;

  // Create signal handlers for both sides
  const senderHandler = new SignalHandler(signalHandlerOptions);
  const receiverHandler = new SignalHandler(signalHandlerOptions);

  // Expose with signal handler
  expose(service, port1, {
    ...coreOptions,
    handlers: [senderHandler, ...((coreOptions as Options).handlers ?? [])],
  });

  // Wrap with signal handler
  const remote = await wrap<T>(port2, {
    ...coreOptions,
    handlers: [receiverHandler, ...((coreOptions as Options).handlers ?? [])],
  });

  return {
    remote,
    senderHandler,
    receiverHandler,
    port1,
    port2,
    [Symbol.dispose]() {
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

/**
 * Wait for a short delay to allow cross-port messages to propagate.
 * More reliable than microtasks for MessageChannel communication.
 */
export function waitForMessages(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
