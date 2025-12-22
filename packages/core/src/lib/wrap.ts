/**
 * Create a typed proxy for a remote service.
 *
 * This is a thin wrapper around Connection that waits for the ready signal
 * and returns a proxy for the root target.
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
import {Connection} from './connection.js';

/**
 * Create a typed proxy that forwards method calls to a remote endpoint.
 *
 * Returns a Promise that resolves when the remote side signals it's ready.
 * This ensures the service is fully initialized before you start making calls,
 * and surfaces any initialization errors from the worker.
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
 * @returns A promise that resolves to a proxy object that forwards method calls
 */
export function wrap<T extends object>(
  endpoint: Endpoint,
  options: NestedProxyOptions,
): Promise<RemoteNested<T>>;
export function wrap<T extends object>(
  endpoint: Endpoint,
  options?: Options,
): Promise<Remote<T>>;
export async function wrap<T extends object>(
  endpoint: Endpoint,
  options: Options = {},
): Promise<Remote<T> | RemoteNested<T>> {
  const connection = new Connection(endpoint, options);
  const rootProxy = await connection.waitForReady();
  return rootProxy as Remote<T>;
}
