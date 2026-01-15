/**
 * Test utilities for supertalk.
 */

import {MessageChannel, type MessagePort} from 'node:worker_threads';
import {expose, wrap} from '../../index.js';
import type {Remote, Options} from '../../index.js';

/**
 * A disposable test context that sets up a service and remote proxy over a MessageChannel.
 */
export interface ServiceContext<T> {
  /** The wrapped remote proxy for calling the service */
  remote: Remote<T>;
  /** The underlying ports (exposed for advanced use cases) */
  port1: MessagePort;
  port2: MessagePort;
  /** Async dispose method for `await using` declarations */
  [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Set up a service and return a remote proxy for testing.
 * Use with `await using` to automatically close ports when the scope ends.
 *
 * @example
 * ```ts
 * await using ctx = await setupService({
 *   add(a: number, b: number) { return a + b; }
 * });
 * const result = await ctx.remote.add(1, 2);
 * // ports are automatically closed when ctx goes out of scope
 * ```
 */
export async function setupService<T extends object>(
  service: T,
  options: Options = {},
): Promise<ServiceContext<T>> {
  const {port1, port2} = new MessageChannel();

  expose(service, port1, options);
  const remote = await wrap<T>(port2, options);

  return {
    remote,
    port1,
    port2,
    [Symbol.asyncDispose]() {
      port1.close();
      port2.close();
      return Promise.resolve();
    },
  };
}
