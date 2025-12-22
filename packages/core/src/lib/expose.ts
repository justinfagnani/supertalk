/**
 * Expose an object's methods over an endpoint.
 *
 * This is a thin wrapper around Connection that registers the service
 * as the root target.
 *
 * @fileoverview Server-side API for exposing services.
 */

import type {Endpoint, Options} from './types.js';
import {Connection} from './connection.js';

/**
 * Expose an object's methods to be called from the other side of an endpoint.
 *
 * Sends a ready signal to the other side with the root proxy. The wrap() side
 * waits for this signal before returning.
 *
 * @param obj - The object whose methods to expose
 * @param endpoint - The endpoint to listen on (Worker, MessagePort, etc.)
 * @param options - Configuration options
 * @returns A cleanup function to stop listening
 */
export function expose(
  obj: object,
  endpoint: Endpoint,
  options: Options = {},
): () => void {
  const connection = new Connection(endpoint, options);
  connection.expose(obj);
  return () => connection.close();
}
