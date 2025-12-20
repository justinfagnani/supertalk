/**
 * Create a typed proxy for a remote object.
 *
 * @packageDocumentation
 */

import type {Endpoint, Remote, Options} from './types.js';
import {ROOT_TARGET} from './types.js';
import {Connection} from './connection.js';

/**
 * Create a typed proxy that forwards method calls to a remote endpoint.
 *
 * @param endpoint - The endpoint to send calls to (Worker, MessagePort, etc.)
 * @param options - Configuration options
 * @returns A proxy object that forwards method calls
 */
export function wrap<T extends object>(
  endpoint: Endpoint,
  options: Options = {},
): Remote<T> {
  const connection = new Connection(endpoint, options);
  return connection.proxy(ROOT_TARGET) as Remote<T>;
}
