/**
 * Create a typed proxy for a remote service.
 *
 * This is a thin wrapper around Connection that returns a proxy for
 * the root target.
 *
 * @fileoverview Client-side API for wrapping remote services.
 */

import type {
  Endpoint,
  Remote,
  RemoteNested,
  Options,
  NestedProxyOptions,
} from './types.js';
import {ROOT_TARGET} from './constants.js';
import {Connection} from './connection.js';

/**
 * Create a typed proxy that forwards method calls to a remote endpoint.
 *
 * The return type depends on the `nestedProxies` option:
 * - `{ nestedProxies: true }` → `RemoteNested<T>` (nested functions are async)
 * - `{ nestedProxies: false }` or omitted → `Remote<T>` (top-level only)
 *
 * Note: TypeScript can only infer the correct type when `nestedProxies` is a
 * literal (`true` or `false`). If you pass a variable with type `Options`,
 * the return type will be `Remote<T>` (you may need to cast).
 *
 * @param endpoint - The endpoint to send calls to (Worker, MessagePort, etc.)
 * @param options - Configuration options
 * @returns A proxy object that forwards method calls
 */
export function wrap<T extends object>(
  endpoint: Endpoint,
  options: NestedProxyOptions,
): RemoteNested<T>;
export function wrap<T extends object>(
  endpoint: Endpoint,
  options?: Options,
): Remote<T>;
export function wrap<T extends object>(
  endpoint: Endpoint,
  options: Options = {},
): Remote<T> | RemoteNested<T> {
  const connection = new Connection(endpoint, options);
  return connection.proxy(ROOT_TARGET) as Remote<T>;
}
