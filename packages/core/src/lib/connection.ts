/**
 * Connection class - unified state and logic for both sides of a supertalk connection.
 *
 * @packageDocumentation
 */

import type {
  Endpoint,
  Message,
  CallMessage,
  WireValue,
  Options,
  ProxyPropertyMetadata,
} from './types.js';
import {PROXY_PROPERTY_BRAND} from './types.js';
import {
  isProxyProperty,
  isPromise,
  isPlainObject,
  serializeError,
  deserializeError,
  NonCloneableError,
} from './protocol.js';

/**
 * Pending call waiting for a response.
 */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

// Marker type guards for nested values
function isProxyMarker(value: unknown): value is {__supertalk_proxy__: number} {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__supertalk_proxy__' in value &&
    typeof (value as {__supertalk_proxy__: unknown}).__supertalk_proxy__ ===
      'number'
  );
}

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
 * A callable function that is also thenable.
 * Enables both `await proxy.method(args)` and `await proxy.property`.
 */
interface ProxyProperty {
  (...args: Array<unknown>): Promise<unknown>;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
  [PROXY_PROPERTY_BRAND]: ProxyPropertyMetadata;
}

/**
 * Unified connection state and logic for supertalk.
 *
 * Both sides of a connection use the same Connection class.
 * The only difference is initialization:
 * - expose() side: registers a root service object
 * - wrap() side: returns a proxy for the root service
 */
export class Connection {
  #endpoint: Endpoint;
  #autoProxy: boolean;
  #debug: boolean;

  // Registry for local objects we expose to remote (strong refs)
  // ID counter for local objects (remote IDs come from the wire)
  #nextLocalId = 1;
  #localById = new Map<number, object>();
  #localByObject = new WeakMap<object, number>();

  // Registry for proxies to remote objects (weak refs)
  #remoteById = new Map<number, WeakRef<object>>();
  #remoteByProxy = new WeakMap<object, number>();
  #remoteCleanup: FinalizationRegistry<number>;

  // Pending RPC calls awaiting response
  #nextCallId = 1;
  #pendingCalls = new Map<number, PendingCall>();

  // Promise tracking
  #nextPromiseId = 1;
  #pendingRemotePromises = new Map<number, PendingCall>();

  // Bound message handler for cleanup
  #handleMessage: (event: MessageEvent<Message>) => void;

  constructor(endpoint: Endpoint, options: Options = {}) {
    this.#endpoint = endpoint;
    this.#autoProxy = options.autoProxy ?? false;
    this.#debug = options.debug ?? false;

    // Set up finalization registry to notify remote when proxies are GC'd
    this.#remoteCleanup = new FinalizationRegistry((proxyId: number) => {
      this.#remoteById.delete(proxyId);
      endpoint.postMessage({type: 'release', proxyId});
    });

    // Bind and attach message handler
    this.#handleMessage = this.#onMessage.bind(this);
    endpoint.addEventListener('message', this.#handleMessage);
  }

  /**
   * Expose an object at a target ID. Use ROOT_TARGET for the root service.
   */
  expose(target: number, obj: object): void {
    this.#registerLocal(obj, target);
  }

  /**
   * Get a proxy for a remote object. Use ROOT_TARGET for the root service.
   */
  proxy(proxyId: number): object {
    return this.#createRemoteProxy(proxyId);
  }

  /**
   * Close the connection and stop listening for messages.
   */
  close(): void {
    this.#endpoint.removeEventListener('message', this.#handleMessage);
  }

  // ============================================================
  // Local object registry (strong refs, we expose to remote)
  // ============================================================

  /**
   * Register a local object and return its ID.
   * If explicitId is provided, use that instead of generating one.
   */
  #registerLocal(obj: object, explicitId?: number): number {
    const existing = this.#localByObject.get(obj);
    if (existing !== undefined) {
      return existing;
    }
    const id = explicitId ?? this.#nextLocalId++;
    this.#localById.set(id, obj);
    this.#localByObject.set(obj, id);
    return id;
  }

  /**
   * Get a local object by its ID.
   */
  #getLocal(id: number): object | undefined {
    return this.#localById.get(id);
  }

  /**
   * Release a local object by its ID.
   */
  #releaseLocal(id: number): void {
    const obj = this.#localById.get(id);
    if (obj !== undefined) {
      this.#localById.delete(id);
      this.#localByObject.delete(obj);
    }
  }

  // ============================================================
  // Remote proxy registry (weak refs, proxies to remote objects)
  // ============================================================

  /**
   * Store a proxy for a remote object ID.
   */
  #setRemote(proxyId: number, proxy: object): void {
    this.#remoteById.set(proxyId, new WeakRef(proxy));
    this.#remoteByProxy.set(proxy, proxyId);
    this.#remoteCleanup.register(proxy, proxyId);
  }

  /**
   * Get the proxy for a remote object ID, if still alive.
   */
  #getRemote(proxyId: number): object | undefined {
    return this.#remoteById.get(proxyId)?.deref();
  }

  /**
   * Get the remote ID for a proxy, if it exists.
   */
  #getRemoteId(proxy: object): number | undefined {
    return this.#remoteByProxy.get(proxy);
  }

  // ============================================================
  // Wire value serialization
  // ============================================================

  /**
   * Serialize a value for transmission.
   */
  toWireValue(value: unknown): WireValue {
    // Check for proxy properties first
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
      const existingId = this.#getRemoteId(value as object);
      if (existingId !== undefined) {
        return {type: 'proxy', proxyId: existingId};
      }
      const proxyId = this.#registerLocal(value as object);
      return {type: 'proxy', proxyId};
    }

    // Null and primitives are raw
    if (value === null || typeof value !== 'object') {
      return {type: 'raw', value};
    }

    // Check if this is a proxy we received from remote - send back original ID
    const existingId = this.#getRemoteId(value);
    if (existingId !== undefined) {
      return {type: 'proxy', proxyId: existingId};
    }

    // Promises get special handling
    if (isPromise(value)) {
      const promiseId = this.#registerPromise(value);
      return {type: 'promise', promiseId};
    }

    // Arrays: only traverse if autoProxy or debug is enabled
    if (Array.isArray(value)) {
      if (this.#autoProxy || this.#debug) {
        const processed = value.map((item, index) =>
          this.#processForClone(item, `[${String(index)}]`),
        );
        return {type: 'raw', value: processed};
      }
      return {type: 'raw', value};
    }

    // Plain objects: only traverse if autoProxy or debug is enabled
    if (isPlainObject(value)) {
      if (this.#autoProxy || this.#debug) {
        const processed: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
          processed[key] = this.#processForClone(
            (value as Record<string, unknown>)[key],
            key,
          );
        }
        return {type: 'raw', value: processed};
      }
      return {type: 'raw', value};
    }

    // Class instances: proxy the whole thing
    const proxyId = this.#registerLocal(value);
    return {type: 'proxy', proxyId};
  }

  /**
   * Process a value for inclusion in a cloned structure.
   */
  #processForClone(value: unknown, path: string): unknown {
    if (typeof value === 'function') {
      if (!this.#autoProxy) {
        throw new NonCloneableError('function', path);
      }
      const existingId = this.#getRemoteId(value as object);
      if (existingId !== undefined) {
        return {__supertalk_proxy__: existingId};
      }
      const proxyId = this.#registerLocal(value as object);
      return {__supertalk_proxy__: proxyId};
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    const existingId = this.#getRemoteId(value);
    if (existingId !== undefined) {
      return {__supertalk_proxy__: existingId};
    }

    if (isPromise(value)) {
      if (!this.#autoProxy) {
        throw new NonCloneableError('promise', path);
      }
      const promiseId = this.#registerPromise(value);
      return {__supertalk_promise__: promiseId};
    }

    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.#processForClone(item, `${path}[${String(index)}]`),
      );
    }

    if (isPlainObject(value)) {
      const processed: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        processed[key] = this.#processForClone(
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
        );
      }
      return processed;
    }

    // Class instance nested in a cloned structure
    if (!this.#autoProxy) {
      throw new NonCloneableError('class-instance', path);
    }
    const proxyId = this.#registerLocal(value);
    return {__supertalk_proxy__: proxyId};
  }

  // ============================================================
  // Wire value deserialization
  // ============================================================

  /**
   * Deserialize a value from wire format.
   */
  fromWireValue(wire: WireValue): unknown {
    if (wire.type === 'proxy') {
      const existing =
        this.#getLocal(wire.proxyId) ?? this.#getRemote(wire.proxyId);
      if (existing) {
        return existing;
      }
      return this.#createRemoteProxy(wire.proxyId);
    }

    if (wire.type === 'promise') {
      return this.#createRemotePromise(wire.promiseId);
    }

    if (wire.type === 'proxy-property') {
      return this.#resolveProxyProperty(wire.targetProxyId, wire.property);
    }

    if (wire.type === 'thrown') {
      throw deserializeError(wire.error);
    }

    // Raw value - may contain nested markers
    return this.#processFromClone(wire.value);
  }

  /**
   * Process a cloned value, replacing markers with actual objects.
   */
  #processFromClone(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (isProxyMarker(value)) {
      const proxyId = value.__supertalk_proxy__;
      const existing = this.#getLocal(proxyId) ?? this.#getRemote(proxyId);
      if (existing) {
        return existing;
      }
      return this.#createRemoteProxy(proxyId);
    }

    if (isPromiseMarker(value)) {
      return this.#createRemotePromise(value.__supertalk_promise__);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.#processFromClone(item));
    }

    const processed: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      processed[key] = this.#processFromClone(
        (value as Record<string, unknown>)[key],
      );
    }
    return processed;
  }

  // ============================================================
  // Promise handling
  // ============================================================

  /**
   * Register a local promise for sending to remote.
   */
  #registerPromise(promise: Promise<unknown>): number {
    const promiseId = this.#nextPromiseId++;
    promise.then(
      (value) => {
        const wireValue = this.toWireValue(value);
        this.#endpoint.postMessage({
          type: 'promise-resolve',
          promiseId,
          value: wireValue,
        });
      },
      (error: unknown) => {
        this.#endpoint.postMessage({
          type: 'promise-reject',
          promiseId,
          error: serializeError(error),
        });
      },
    );
    return promiseId;
  }

  /**
   * Create a local promise for a remote promise ID.
   */
  #createRemotePromise(promiseId: number): Promise<unknown> {
    const {promise, resolve, reject} = Promise.withResolvers<unknown>();
    this.#pendingRemotePromises.set(promiseId, {resolve, reject});
    return promise;
  }

  // ============================================================
  // Remote proxy creation
  // ============================================================

  /**
   * Create a proxy for a remote object.
   */
  #createRemoteProxy(proxyId: number): object {
    const existing = this.#getRemote(proxyId);
    if (existing) {
      return existing;
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const proxyTarget = function () {} as unknown as object;

    const proxy = new Proxy(proxyTarget, {
      apply: (_target, _thisArg, args: Array<unknown>) => {
        return this.#makeCall(proxyId, undefined, args);
      },

      get: (_target, prop) => {
        if (typeof prop !== 'string') {
          return undefined;
        }
        if (prop === 'then') {
          return undefined; // Not thenable at top level
        }
        return this.#createProxyProperty(proxyId, prop);
      },
    });

    this.#setRemote(proxyId, proxy);
    return proxy;
  }

  /**
   * Create a proxy property for lazy property access.
   */
  #createProxyProperty(target: number, prop: string): ProxyProperty {
    const callable = (...args: Array<unknown>): Promise<unknown> => {
      return this.#makeCall(target, prop, args);
    };

    callable.then = <TResult1 = unknown, TResult2 = never>(
      onfulfilled?:
        | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): Promise<TResult1 | TResult2> => {
      return this.#makeGet(target, prop).then(onfulfilled, onrejected);
    };

    (callable as ProxyProperty)[PROXY_PROPERTY_BRAND] = {
      targetProxyId: target,
      property: prop,
    };

    return callable as ProxyProperty;
  }

  /**
   * Resolve a proxy property by looking up the local target.
   */
  #resolveProxyProperty(targetProxyId: number, property: string): unknown {
    const target = this.#getLocal(targetProxyId);
    if (!target) {
      throw new ReferenceError(
        `Proxy property target ${String(targetProxyId)} not found`,
      );
    }
    return (target as Record<string, unknown>)[property];
  }

  // ============================================================
  // RPC primitives
  // ============================================================

  /**
   * Make an RPC call to the remote side.
   */
  #makeCall(
    target: number,
    method: string | undefined,
    args: Array<unknown>,
  ): Promise<unknown> {
    const wireArgs = args.map((arg) => this.toWireValue(arg));
    const {promise, resolve, reject} = Promise.withResolvers<unknown>();
    const id = this.#nextCallId++;
    this.#pendingCalls.set(id, {resolve, reject});
    this.#endpoint.postMessage({
      type: 'call',
      id,
      target,
      action: 'call',
      method,
      args: wireArgs,
    });
    return promise;
  }

  /**
   * Make a property GET request to the remote side.
   */
  #makeGet(target: number, property: string): Promise<unknown> {
    const {promise, resolve, reject} = Promise.withResolvers<unknown>();
    const id = this.#nextCallId++;
    this.#pendingCalls.set(id, {resolve, reject});
    this.#endpoint.postMessage({
      type: 'call',
      id,
      target,
      action: 'get',
      method: property,
      args: [],
    });
    return promise;
  }

  // ============================================================
  // Message handling
  // ============================================================

  async #onMessage(event: MessageEvent<Message>): Promise<void> {
    const message = event.data;
    if ((message as unknown) == null) {
      return;
    }

    switch (message.type) {
      case 'release':
        this.#releaseLocal(message.proxyId);
        break;
      case 'promise-resolve': {
        const pending = this.#pendingRemotePromises.get(message.promiseId);
        if (pending) {
          this.#pendingRemotePromises.delete(message.promiseId);
          try {
            pending.resolve(this.fromWireValue(message.value));
          } catch (error) {
            pending.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
        break;
      }
      case 'promise-reject': {
        const pending = this.#pendingRemotePromises.get(message.promiseId);
        if (pending) {
          this.#pendingRemotePromises.delete(message.promiseId);
          pending.reject(deserializeError(message.error));
        }
        break;
      }
      case 'return': {
        const call = this.#pendingCalls.get(message.id);
        if (call) {
          this.#pendingCalls.delete(message.id);
          try {
            call.resolve(this.fromWireValue(message.value));
          } catch (error) {
            call.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
        break;
      }
      case 'throw': {
        const call = this.#pendingCalls.get(message.id);
        if (call) {
          this.#pendingCalls.delete(message.id);
          call.reject(deserializeError(message.error));
        }
        break;
      }
      case 'call':
        await this.#handleCall(message);
        break;
      default:
        // Exhaustiveness check
        message satisfies never;
    }
  }

  async #handleCall(message: CallMessage): Promise<void> {
    const {id, target, method, args, action} = message;

    // Deserialize arguments
    const deserializedArgs = args.map((arg) => this.fromWireValue(arg));

    // Look up the target object
    const proxyTarget = this.#getLocal(target);
    if (!proxyTarget) {
      this.#endpoint.postMessage({
        type: 'throw',
        id,
        error: {
          name: 'ReferenceError',
          message: `Proxy target ${String(target)} not found`,
        },
      });
      return;
    }

    try {
      let result: unknown;

      if (action === 'get') {
        if (method === undefined) {
          throw new TypeError('Property name required for get action');
        }
        result = (proxyTarget as Record<string, unknown>)[method];
      } else if (method === undefined) {
        // Direct function invocation
        if (typeof proxyTarget !== 'function') {
          throw new TypeError('Target is not callable');
        }
        result = await (proxyTarget as (...a: Array<unknown>) => unknown)(
          ...deserializedArgs,
        );
      } else {
        // Method invocation
        const targetObj = proxyTarget as Record<string, unknown>;
        const value = targetObj[method];
        if (typeof value !== 'function') {
          throw new TypeError(`${method} is not a function`);
        }
        result = await (value as (...a: Array<unknown>) => unknown).apply(
          proxyTarget,
          deserializedArgs,
        );
      }

      this.#endpoint.postMessage({
        type: 'return',
        id,
        value: this.toWireValue(result),
      });
    } catch (error) {
      this.#endpoint.postMessage({
        type: 'throw',
        id,
        error: serializeError(error),
      });
    }
  }
}
