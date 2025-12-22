/**
 * Wire protocol utilities and runtime helpers.
 *
 * This file contains:
 * - `proxy()` function for explicit proxy marking
 * - Detection helpers (isPromise, isLocalProxy, etc.)
 * - Error serialization/deserialization
 * - NonCloneableError for debug mode
 *
 * Constants live in constants.ts. Type definitions live in types.ts.
 *
 * @fileoverview Runtime utilities for the wire protocol.
 */

import type {
  SerializedError,
  ProxyPropertyMetadata,
  LocalProxy,
} from './types.js';
import {LOCAL_PROXY, PROXY_PROPERTY_BRAND, TRANSFER} from './constants.js';

// ============================================================
// Proxy marker
// ============================================================

/**
 * Creates a LocalProxy marker for explicit proxying.
 *
 * Use this to explicitly mark values that should be proxied rather than cloned.
 * This is required in nested mode for class instances and objects you want to
 * keep mutable/shared.
 *
 * **When to use `proxy()`:**
 * - **Mutable objects** — The remote side should see updates
 * - **Large graphs** — Avoid cloning expensive data structures
 * - **Class instances with methods** — Preserve the prototype API
 *
 * **When NOT to use `proxy()`:**
 * - Immutable data (cloning is fine, avoids round-trips)
 * - Small DTOs / config objects
 * - Anything the remote side will just read once
 *
 * @example
 * ```ts
 * // Mutable state
 * createCounter(): LocalProxy<Counter> {
 *   return proxy(new Counter());  // Mutations visible remotely
 * }
 *
 * // Large graph
 * getDocument(): LocalProxy<Document> {
 *   return proxy(this.doc);  // Don't clone the entire tree
 * }
 *
 * // Immutable data — just return it (will be cloned)
 * getData(): { value: number } {
 *   return { value: 42 };
 * }
 * ```
 */
export function proxy<T>(value: T): LocalProxy<T> {
  return {[LOCAL_PROXY]: true, value};
}

/**
 * Check if a value is a LocalProxy marker.
 */
export function isLocalProxy(value: unknown): value is LocalProxy<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, LOCAL_PROXY)
  );
}

// ============================================================
// Transfer marker
// ============================================================

/**
 * A value marked for transfer when sent across the wire.
 *
 * Transferred values are moved (not copied) — faster for large buffers,
 * but the original becomes unusable (neutered).
 */
export interface TransferMarker<T extends Transferable> {
  readonly [TRANSFER]: true;
  readonly value: T;
}

/**
 * Mark a value for transfer across the wire.
 *
 * Transferred values are moved (not copied) using postMessage's transfer list.
 * This is faster for large data but neuters the original.
 *
 * @example
 * ```ts
 * const service = {
 *   getBuffer(): ArrayBuffer {
 *     const buf = new ArrayBuffer(1024 * 1024);
 *     fillBuffer(buf);
 *     return transfer(buf);  // Move, don't copy
 *   }
 * };
 * ```
 */
export function transfer<T extends Transferable>(value: T): TransferMarker<T> {
  return {[TRANSFER]: true, value};
}

/**
 * Check if a value is a TransferMarker.
 */
export function isTransferMarker(
  value: unknown,
): value is TransferMarker<Transferable> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, TRANSFER)
  );
}

// ============================================================
// Detection helpers
// ============================================================

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
 * Error thrown when a non-cloneable value is encountered in shallow mode.
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
          : 'Class instance';
    const hint =
      valueType === 'class-instance'
        ? 'Use proxy() to wrap it, or use nestedProxies: true for functions/promises.'
        : 'Use nestedProxies: true to auto-proxy nested functions and promises.';
    super(`${t} at "${path}" cannot be cloned. ${hint}`);
    this.name = 'NonCloneableError';
  }
}
