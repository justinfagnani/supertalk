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
  SerializedError,
  WireValue,
} from './types.js';
import {ROOT_TARGET} from './types.js';

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
 * Callback to register a value that needs proxying.
 * Returns the proxy ID assigned to this value.
 */
export type ProxyRegistrar = (value: object) => number;

/**
 * Callback to look up a proxy by ID.
 * Returns the local proxy object for a remote proxy ID.
 */
export type ProxyResolver = (proxyId: number) => object | undefined;

/**
 * Error thrown when a non-cloneable value is encountered in manual mode.
 */
export class NonCloneableError extends Error {
  constructor(
    public readonly valueType: 'function' | 'class-instance',
    public readonly path: string,
  ) {
    const typeName =
      valueType === 'function'
        ? 'Function'
        : 'Class instance (non-plain object)';
    super(
      `${typeName} found at "${path}" cannot be sent across the boundary. ` +
        `In manual mode (autoProxy: false), only top-level functions and ` +
        `class instances are proxied. Enable autoProxy: true to proxy nested values.`,
    );
    this.name = 'NonCloneableError';
  }
}

/**
 * Serialize a value for transmission, replacing proxy-needing values with references.
 *
 * In auto-proxy mode (autoProxy: true), walks the value recursively:
 * - Functions → proxy reference
 * - Class instances → proxy reference
 * - Plain objects → recursively process properties
 * - Arrays → recursively process elements
 * - Primitives → raw value
 *
 * In manual mode (autoProxy: false, the default), only top-level values are
 * considered for proxying. Nested values are passed through to structured clone,
 * which will throw DataCloneError for non-cloneable values like functions.
 *
 * In debug mode (debug: true with autoProxy: false), traversal happens to detect
 * non-cloneable values early and throw NonCloneableError with helpful paths.
 */
export function toWireValue(
  value: unknown,
  registerProxy: ProxyRegistrar,
  autoProxy = false,
  debug = false,
): WireValue {
  // Functions are always proxied at top level
  if (typeof value === 'function') {
    const proxyId = registerProxy(value as object);
    return {type: 'proxy', proxyId};
  }

  // Null and primitives are raw
  if (value === null || typeof value !== 'object') {
    return {type: 'raw', value};
  }

  // Arrays: only traverse if autoProxy or debug is enabled
  if (Array.isArray(value)) {
    if (autoProxy || debug) {
      const processed = value.map((item, index) =>
        processForClone(item, registerProxy, autoProxy, `[${String(index)}]`),
      );
      return {type: 'raw', value: processed};
    }
    // Manual mode without debug: pass through to structured clone
    return {type: 'raw', value};
  }

  // Plain objects: only traverse if autoProxy or debug is enabled
  if (isPlainObject(value)) {
    if (autoProxy || debug) {
      const processed: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        processed[key] = processForClone(
          (value as Record<string, unknown>)[key],
          registerProxy,
          autoProxy,
          key,
        );
      }
      return {type: 'raw', value: processed};
    }
    // Manual mode without debug: pass through to structured clone
    return {type: 'raw', value};
  }

  // Class instances: proxy the whole thing at top level
  const proxyId = registerProxy(value);
  return {type: 'proxy', proxyId};
}

/**
 * Process a value for inclusion in a cloned structure.
 * Returns the processed value (not wrapped in WireValue).
 *
 * In manual mode (autoProxy: false), throws NonCloneableError for functions
 * and class instances. In auto-proxy mode, replaces them with proxy markers.
 *
 * @param value - The value to process
 * @param registerProxy - Callback to register a value for proxying
 * @param autoProxy - Whether auto-proxy mode is enabled
 * @param path - The path to this value (for error messages)
 */
function processForClone(
  value: unknown,
  registerProxy: ProxyRegistrar,
  autoProxy: boolean,
  path: string,
): unknown {
  if (typeof value === 'function') {
    if (!autoProxy) {
      throw new NonCloneableError('function', path);
    }
    // Replace function with a marker that includes the proxy ID
    const proxyId = registerProxy(value as object);
    return {__supertalk_proxy__: proxyId};
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      processForClone(
        item,
        registerProxy,
        autoProxy,
        `${path}[${String(index)}]`,
      ),
    );
  }

  if (isPlainObject(value)) {
    const processed: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      processed[key] = processForClone(
        (value as Record<string, unknown>)[key],
        registerProxy,
        autoProxy,
        `${path}.${key}`,
      );
    }
    return processed;
  }

  // Class instance nested in a cloned structure
  if (!autoProxy) {
    throw new NonCloneableError('class-instance', path);
  }
  const proxyId = registerProxy(value);
  return {__supertalk_proxy__: proxyId};
}

/**
 * Check if a value is a proxy marker.
 */
function isProxyMarker(value: unknown): value is {__supertalk_proxy__: number} {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__supertalk_proxy__' in value &&
    typeof (value as {__supertalk_proxy__: unknown}).__supertalk_proxy__ ===
      'number'
  );
}

/**
 * Deserialize a value from wire format, replacing proxy references with local proxies.
 */
export function fromWireValue(
  wire: WireValue,
  resolveProxy: ProxyResolver,
  createRemoteProxy: (proxyId: number) => object,
): unknown {
  if (wire.type === 'proxy') {
    // Look up existing proxy or create new one
    const existing = resolveProxy(wire.proxyId);
    if (existing) {
      return existing;
    }
    return createRemoteProxy(wire.proxyId);
  }

  if (wire.type === 'thrown') {
    throw deserializeError(wire.error);
  }

  // Raw value - may contain nested proxy markers
  return processFromClone(wire.value, resolveProxy, createRemoteProxy);
}

/**
 * Process a cloned value, replacing proxy markers with actual proxies.
 */
function processFromClone(
  value: unknown,
  resolveProxy: ProxyResolver,
  createRemoteProxy: (proxyId: number) => object,
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Check for proxy marker
  if (isProxyMarker(value)) {
    const proxyId = value.__supertalk_proxy__;
    const existing = resolveProxy(proxyId);
    if (existing) {
      return existing;
    }
    return createRemoteProxy(proxyId);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      processFromClone(item, resolveProxy, createRemoteProxy),
    );
  }

  // Plain object - recursively process
  const processed: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    processed[key] = processFromClone(
      (value as Record<string, unknown>)[key],
      resolveProxy,
      createRemoteProxy,
    );
  }
  return processed;
}
