/**
 * Test utilities for supertalk.
 *
 * @packageDocumentation
 */

import {MessageChannel, type MessagePort} from 'node:worker_threads';
import {expose, wrap} from '../../index.js';
import type {Remote} from '../../index.js';

/**
 * A disposable test context that sets up a service and remote proxy over a MessageChannel.
 */
export interface ServiceContext<T extends object> {
  /** The wrapped remote proxy for calling the service */
  remote: Remote<T>;
  /** The underlying ports (exposed for advanced use cases) */
  port1: MessagePort;
  port2: MessagePort;
  /** Dispose method for `using` declarations */
  [Symbol.dispose]: () => void;
}

/**
 * Set up a service and return a remote proxy for testing.
 * Use with `using` to automatically close ports when the scope ends.
 *
 * @example
 * ```ts
 * using ctx = setupService({
 *   add(a: number, b: number) { return a + b; }
 * });
 * const result = await ctx.remote.add(1, 2);
 * // ports are automatically closed when ctx goes out of scope
 * ```
 */
export function setupService<T extends object>(service: T): ServiceContext<T> {
  const {port1, port2} = new MessageChannel();

  expose(service, port1);
  const remote = wrap<T>(port2);

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
