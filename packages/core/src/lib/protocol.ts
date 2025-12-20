/**
 * Message protocol utilities.
 *
 * @packageDocumentation
 */

import type {
  CallMessage,
  ReturnMessage,
  ThrowMessage,
  ReleaseMessage,
  PromiseResolveMessage,
  PromiseRejectMessage,
  SerializedError,
  WireValue,
  ProxyPropertyMetadata,
} from './types.js';
import {ROOT_TARGET, PROXY_PROPERTY_BRAND} from './types.js';

/**
 * Check if a value is a proxy property created by supertalk.
 * These are branded with a symbol containing metadata about the target proxy.
 */
export function isProxyProperty(
  value: unknown,
): value is {[PROXY_PROPERTY_BRAND]: ProxyPropertyMetadata} {
  return (
    typeof value === 'function' &&
    PROXY_PROPERTY_BRAND in value &&
    typeof (value as Record<symbol, unknown>)[PROXY_PROPERTY_BRAND] === 'object'
  );
}

/**
 * Check if a value is a Promise (or Promise-like with .then and .catch).
 *
 * We require both .then() and .catch() to distinguish from our own
 * "proxy properties" which only have .then(). However, when a value
 * is a remote proxy we created, it will be detected earlier via
 * getRemoteProxyId() and won't reach this check.
 */
export function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Promise<unknown>).then === 'function' &&
    typeof (value as Promise<unknown>).catch === 'function'
  );
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
 * Create a call message for the root service.
 */
export function createCallMessage(
  id: number,
  method: string,
  args: Array<WireValue>,
): CallMessage {
  return {
    type: 'call',
    id,
    target: ROOT_TARGET,
    action: 'call',
    method,
    args,
  };
}

/**
 * Create a call message for a proxied target (method call).
 */
export function createProxyCallMessage(
  id: number,
  target: number,
  method: string | undefined,
  args: Array<WireValue>,
): CallMessage {
  return {
    type: 'call',
    id,
    target,
    action: 'call',
    method,
    args,
  };
}

/**
 * Create a get message for a proxied target (property access).
 */
export function createProxyGetMessage(
  id: number,
  target: number,
  property: string,
): CallMessage {
  return {
    type: 'call',
    id,
    target,
    action: 'get',
    method: property,
    args: [],
  };
}

/**
 * Create a return message.
 */
export function createReturnMessage(
  id: number,
  value: WireValue,
): ReturnMessage {
  return {
    type: 'return',
    id,
    value,
  };
}

/**
 * Create a throw message.
 */
export function createThrowMessage(
  id: number,
  error: SerializedError,
): ThrowMessage {
  return {
    type: 'throw',
    id,
    error,
  };
}

/**
 * Create a release message.
 */
export function createReleaseMessage(proxyId: number): ReleaseMessage {
  return {
    type: 'release',
    proxyId,
  };
}

/**
 * Create a promise resolve message.
 */
export function createPromiseResolveMessage(
  promiseId: number,
  value: WireValue,
): PromiseResolveMessage {
  return {
    type: 'promise-resolve',
    promiseId,
    value,
  };
}

/**
 * Create a promise reject message.
 */
export function createPromiseRejectMessage(
  promiseId: number,
  error: SerializedError,
): PromiseRejectMessage {
  return {
    type: 'promise-reject',
    promiseId,
    error,
  };
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
    const typeName =
      valueType === 'function'
        ? 'Function'
        : valueType === 'promise'
          ? 'Promise'
          : 'Class instance (non-plain object)';
    super(
      `${typeName} found at "${path}" cannot be sent across the boundary. ` +
        `In manual mode (autoProxy: false), only top-level functions, ` +
        `class instances, and promises are proxied. Enable autoProxy: true ` +
        `to proxy nested values.`,
    );
    this.name = 'NonCloneableError';
  }
}
