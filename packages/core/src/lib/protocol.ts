/**
 * Message protocol utilities.
 *
 * @packageDocumentation
 */

import type {SerializedError, ProxyPropertyMetadata} from './types.js';
import {PROXY_PROPERTY_BRAND} from './types.js';

/**
 * Check if a value is a proxy property created by supertalk.
 * These are branded with a symbol containing metadata about the target proxy.
 */
export function isProxyProperty(
  value: unknown,
): value is {[PROXY_PROPERTY_BRAND]: ProxyPropertyMetadata} {
  return (
    typeof (value as {[PROXY_PROPERTY_BRAND]: ProxyPropertyMetadata} | null)?.[
      PROXY_PROPERTY_BRAND
    ] === 'object'
  );
}

/**
 * Check if a value is a Promise (or thenable).
 */
export function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}

/**
 * Check if an object is a plain object (prototype is null or Object.prototype).
 * Plain objects are cloned; class instances are proxied.
 */
export function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === null || proto === Object.prototype;
}

/**
 * Serialize an error for transmission.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
    };
    if (error.stack !== undefined) {
      serialized.stack = error.stack;
    }
    return serialized;
  }
  return {
    name: 'Error',
    message: String(error),
  };
}

/**
 * Deserialize an error from transmission.
 */
export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack) {
    error.stack = serialized.stack;
  }
  return error;
}

/**
 * Error thrown when a non-cloneable value is encountered in manual mode.
 */
export class NonCloneableError extends Error {
  constructor(
    public readonly valueType: 'function' | 'class-instance' | 'promise',
    public readonly path: string,
  ) {
    const t =
      valueType === 'function'
        ? 'Function'
        : valueType === 'promise'
          ? 'Promise'
          : 'class instance';
    super(`${t} at "${path}" cannot be cloned. Use autoProxy: true.`);
    this.name = 'NonCloneableError';
  }
}
