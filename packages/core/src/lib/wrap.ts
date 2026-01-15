/**
 * Create a typed proxy for a remote service.
 *
 * This is a thin wrapper around Connection that waits for the ready signal
 * and returns a proxy for the root target.
 *
 * @fileoverview Client-side API for wrapping remote services.
 */

import type {Endpoint, Remote, Options} from './types.js';
import {Connection} from './connection.js';

/**
 * Create a typed proxy that forwards method calls to a remote endpoint.
 *
 * Returns a Promise that resolves when the remote side signals it's ready.
 * This ensures the service is fully initialized before you start making calls,
 * and surfaces any initialization errors from the worker.
 *
 * @param endpoint - The endpoint to send calls to (Worker, MessagePort, etc.)
 * @param options - Configuration options
 * @returns A promise that resolves to a proxy object that forwards method calls
 */
export async function wrap<T extends object>(
  endpoint: Endpoint,
  options: Options = {},
): Promise<Remote<T>> {
  const connection = new Connection(endpoint, options);
  const rootProxy = await connection.waitForReady();
  return rootProxy as Remote<T>;
}
