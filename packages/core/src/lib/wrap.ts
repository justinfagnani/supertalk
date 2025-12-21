/**
 * Create a typed proxy for a remote object.
 *
 * @packageDocumentation
 */

import type {
  Endpoint,
  Remote,
  RemoteAutoProxy,
  Options,
  AutoProxyOptions,
} from './types.js';
import {ROOT_TARGET} from './types.js';
import {Connection} from './connection.js';

/**
 * Create a typed proxy that forwards method calls to a remote endpoint.
 *
 * The return type depends on the `autoProxy` option:
 * - `{ autoProxy: true }` → `RemoteAutoProxy<T>` (nested functions are async)
 * - `{ autoProxy: false }` or omitted → `Remote<T>` (top-level only)
 *
 * Note: TypeScript can only infer the correct type when `autoProxy` is a
 * literal (`true` or `false`). If you pass a variable with type `Options`,
 * the return type will be `Remote<T>` (you may need to cast).
 *
 * @param endpoint - The endpoint to send calls to (Worker, MessagePort, etc.)
 * @param options - Configuration options
 * @returns A proxy object that forwards method calls
 */
export function wrap<T extends object>(
  endpoint: Endpoint,
  options: AutoProxyOptions,
): RemoteAutoProxy<T>;
export function wrap<T extends object>(
  endpoint: Endpoint,
  options?: Options,
): Remote<T>;
export function wrap<T extends object>(
  endpoint: Endpoint,
  options: Options = {},
): Remote<T> | RemoteAutoProxy<T> {
  const connection = new Connection(endpoint, options);
  return connection.proxy(ROOT_TARGET) as Remote<T>;
}
