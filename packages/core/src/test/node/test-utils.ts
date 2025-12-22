/**
 * Test utilities for supertalk.
 */

import {MessageChannel, type MessagePort} from 'node:worker_threads';
import {expose, wrap} from '../../index.js';
import type {
  Remote,
  RemoteNested,
  Options,
  NestedProxyOptions,
  ShallowOptions,
} from '../../index.js';

/**
 * A disposable test context that sets up a service and remote proxy over a MessageChannel.
 */
export interface ServiceContext<R> {
  /** The wrapped remote proxy for calling the service */
  remote: R;
  /** The underlying ports (exposed for advanced use cases) */
  port1: MessagePort;
  port2: MessagePort;
  /** Dispose method for `using` declarations */
  [Symbol.dispose]: () => void;
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
export function setupService<T extends object>(
  service: T,
  options: NestedProxyOptions,
): Promise<ServiceContext<RemoteNested<T>>>;
export function setupService<T extends object>(
  service: T,
  options?: ShallowOptions,
): Promise<ServiceContext<Remote<T>>>;
export async function setupService<T extends object>(
  service: T,
  options: Options = {},
): Promise<ServiceContext<Remote<T> | RemoteNested<T>>> {
  const {port1, port2} = new MessageChannel();

  expose(service, port1, options);
  const remote = await wrap<T>(port2, options);

  return {
    remote,
    port1,
    port2,
    [Symbol.dispose]() {
      port1.close();
      port2.close();
    },
  };
}
