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
 * Callback to register a value that needs proxying.
 * Returns the proxy ID assigned to this value.
 */
export type ProxyRegistrar = (value: object) => number;

/**
 * Callback to register a promise and set up resolution forwarding.
 * Returns the promise ID assigned to this promise.
 */
export type PromiseRegistrar = (promise: Promise<unknown>) => number;

/**
 * Callback to look up a proxy by ID.
 * Returns the local proxy object for a remote proxy ID.
 */
export type ProxyResolver = (proxyId: number) => object | undefined;

/**
 * Callback to check if a value is a proxy we received from the remote side.
 * If so, returns its original proxy ID so we can send it back.
 * This avoids double-proxying and allows the remote to get their original object.
 */
export type RemoteProxyResolver = (value: object) => number | undefined;

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
        `class instances, and promises are proxied. Enable autoProxy: true to proxy nested values.`,
    );
    this.name = 'NonCloneableError';
  }
}

/**
 * Serialize a value for transmission, replacing proxy-needing values with references.
 *
 * In auto-proxy mode (autoProxy: true), walks the value recursively:
 * - Functions → proxy reference
 * - Promises → promise reference (with resolution forwarding)
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
  registerPromise?: PromiseRegistrar,
  getRemoteProxyId?: RemoteProxyResolver,
): WireValue {
  // Check for proxy properties first - these are our internal construct
  // for lazy property access. Send as special type so receiver can resolve directly.
  if (isProxyProperty(value)) {
    const metadata = value[PROXY_PROPERTY_BRAND];
    return {
      type: 'proxy-property',
      targetProxyId: metadata.targetProxyId,
      property: metadata.property,
    };
  }

  // Functions are always proxied at top level
  if (typeof value === 'function') {
    // Check if this is a proxy we received from remote - send back original ID
    if (getRemoteProxyId) {
      const existingId = getRemoteProxyId(value as object);
      if (existingId !== undefined) {
        return {type: 'proxy', proxyId: existingId};
      }
    }
    const proxyId = registerProxy(value as object);
    return {type: 'proxy', proxyId};
  }

  // Null and primitives are raw
  if (value === null || typeof value !== 'object') {
    return {type: 'raw', value};
  }

  // Check if this object is a proxy we received from remote - send back original ID
  // Do this before other checks to avoid re-proxying remote objects
  if (getRemoteProxyId) {
    const existingId = getRemoteProxyId(value);
    if (existingId !== undefined) {
      return {type: 'proxy', proxyId: existingId};
    }
  }

  // Promises get special handling at top level
  if (isPromise(value)) {
    if (registerPromise) {
      const promiseId = registerPromise(value);
      return {type: 'promise', promiseId};
    }
    // If no promise registrar, treat as class instance (will be proxied)
    const proxyId = registerProxy(value);
    return {type: 'proxy', proxyId};
  }

  // Arrays: only traverse if autoProxy or debug is enabled
  if (Array.isArray(value)) {
    if (autoProxy || debug) {
      const processed = value.map((item, index) =>
        processForClone(
          item,
          registerProxy,
          autoProxy,
          `[${String(index)}]`,
          registerPromise,
          getRemoteProxyId,
        ),
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
          registerPromise,
          getRemoteProxyId,
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
 * In manual mode (autoProxy: false), throws NonCloneableError for functions,
 * promises, and class instances. In auto-proxy mode, replaces them with markers.
 *
 * @param value - The value to process
 * @param registerProxy - Callback to register a value for proxying
 * @param autoProxy - Whether auto-proxy mode is enabled
 * @param path - The path to this value (for error messages)
 * @param registerPromise - Optional callback to register promises
 * @param getRemoteProxyId - Optional callback to check if value is a remote proxy
 */
function processForClone(
  value: unknown,
  registerProxy: ProxyRegistrar,
  autoProxy: boolean,
  path: string,
  registerPromise?: PromiseRegistrar,
  getRemoteProxyId?: RemoteProxyResolver,
): unknown {
  if (typeof value === 'function') {
    if (!autoProxy) {
      throw new NonCloneableError('function', path);
    }
    // Check if this is a proxy we received from remote
    if (getRemoteProxyId) {
      const existingId = getRemoteProxyId(value as object);
      if (existingId !== undefined) {
        return {__supertalk_proxy__: existingId};
      }
    }
    // Replace function with a marker that includes the proxy ID
    const proxyId = registerProxy(value as object);
    return {__supertalk_proxy__: proxyId};
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Check if this is a proxy we received from remote - send back original ID
  if (getRemoteProxyId) {
    const existingId = getRemoteProxyId(value);
    if (existingId !== undefined) {
      return {__supertalk_proxy__: existingId};
    }
  }

  // Handle promises
  if (isPromise(value)) {
    if (!autoProxy) {
      throw new NonCloneableError('promise', path);
    }
    if (registerPromise) {
      const promiseId = registerPromise(value);
      return {__supertalk_promise__: promiseId};
    }
    // Fallback: treat as class instance
    const proxyId = registerProxy(value);
    return {__supertalk_proxy__: proxyId};
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      processForClone(
        item,
        registerProxy,
        autoProxy,
        `${path}[${String(index)}]`,
        registerPromise,
        getRemoteProxyId,
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
        registerPromise,
        getRemoteProxyId,
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
 * Check if a value is a promise marker.
 */
function isPromiseMarker(
  value: unknown,
): value is {__supertalk_promise__: number} {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__supertalk_promise__' in value &&
    typeof (value as {__supertalk_promise__: unknown}).__supertalk_promise__ ===
      'number'
  );
}

/**
 * Callback to create a local promise for a remote promise ID.
 */
export type PromiseCreator = (promiseId: number) => Promise<unknown>;

/**
 * Callback to resolve a proxy property by looking up the target object
 * and accessing the property. Returns the property value directly.
 */
export type ProxyPropertyResolver = (
  targetProxyId: number,
  property: string,
) => unknown;

/**
 * Deserialize a value from wire format, replacing proxy references with local proxies.
 */
export function fromWireValue(
  wire: WireValue,
  resolveProxy: ProxyResolver,
  createRemoteProxy: (proxyId: number) => object,
  createRemotePromise?: PromiseCreator,
  resolveProxyProperty?: ProxyPropertyResolver,
): unknown {
  if (wire.type === 'proxy') {
    // Look up existing proxy or create new one
    const existing = resolveProxy(wire.proxyId);
    if (existing) {
      return existing;
    }
    return createRemoteProxy(wire.proxyId);
  }

  if (wire.type === 'promise') {
    if (createRemotePromise) {
      return createRemotePromise(wire.promiseId);
    }
    // Fallback: treat as unresolved (shouldn't happen with proper setup)
    throw new Error(`Promise ${String(wire.promiseId)} cannot be resolved`);
  }

  if (wire.type === 'proxy-property') {
    if (resolveProxyProperty) {
      return resolveProxyProperty(wire.targetProxyId, wire.property);
    }
    // Fallback: shouldn't happen with proper setup
    throw new Error(
      `Cannot resolve proxy property for proxy ${String(wire.targetProxyId)}.${wire.property}`,
    );
  }

  if (wire.type === 'thrown') {
    throw deserializeError(wire.error);
  }

  // Raw value - may contain nested proxy/promise markers
  return processFromClone(
    wire.value,
    resolveProxy,
    createRemoteProxy,
    createRemotePromise,
  );
}

/**
 * Process a cloned value, replacing proxy and promise markers with actual objects.
 */
function processFromClone(
  value: unknown,
  resolveProxy: ProxyResolver,
  createRemoteProxy: (proxyId: number) => object,
  createRemotePromise?: PromiseCreator,
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

  // Check for promise marker
  if (isPromiseMarker(value)) {
    if (createRemotePromise) {
      return createRemotePromise(value.__supertalk_promise__);
    }
    throw new Error(
      `Promise ${String(value.__supertalk_promise__)} cannot be resolved`,
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      processFromClone(
        item,
        resolveProxy,
        createRemoteProxy,
        createRemotePromise,
      ),
    );
  }

  // Plain object - recursively process
  const processed: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    processed[key] = processFromClone(
      (value as Record<string, unknown>)[key],
      resolveProxy,
      createRemoteProxy,
      createRemotePromise,
    );
  }
  return processed;
}
