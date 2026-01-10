/**
 * Connection class - manages state and communication for both sides of a
 * Supertalk connection.
 *
 * This file contains:
 * - Connection class with proxy lifecycle management
 * - Wire value serialization/deserialization (#toWire/#fromWire)
 * - Message handling and dispatch
 * - Proxy creation and release tracking
 *
 * @fileoverview Core connection implementation.
 */

import type {
  Endpoint,
  Message,
  CallMessage,
  WireValue,
  WireProxyProperty,
  WireThrown,
  Options,
  ProxyPropertyMetadata,
  Handler,
  ToWireContext,
  FromWireContext,
  HandlerConnectionContext,
} from './types.js';
import {isWireProxy, isWirePromise} from './types.js';
import {PROXY_PROPERTY_BRAND, WIRE_TYPE, HANDSHAKE_ID} from './constants.js';
import {
  isLocalProxy,
  isProxyProperty,
  isPromise,
  isTransferMarker,
  serializeError,
  deserializeError,
  NonCloneableError,
} from './protocol.js';

/**
 * Check if a value is a plain object (prototype is null or Object.prototype).
 * Used to decide whether to traverse for nested markers vs pass through to
 * structured clone.
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === null || proto === Object.prototype;
}

/**
 * Pending call waiting for a response.
 */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
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
 * Unified connection state and logic for Supertalk.
 *
 * Both sides of a connection use the same Connection class.
 * The only difference is initialization:
 * - expose() side: registers a root service object
 * - wrap() side: returns a proxy for the root service
 */
export class Connection {
  #endpoint: Endpoint;
  #nestedProxies: boolean;
  #debug: boolean;
  #handlers: Array<Handler>;
  #handlersByWireType = new Map<string, Handler>();

  // Registry for local objects we expose to remote (strong refs)
  // ID counter for local objects (remote IDs come from the wire)
  #nextLocalId = 0;
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
    this.#nestedProxies = options.nestedProxies ?? false;
    this.#debug = options.debug ?? false;
    this.#handlers = options.handlers ?? [];

    // Build handler lookup map and call connect() on handlers that support it
    for (const handler of this.#handlers) {
      this.#handlersByWireType.set(handler.wireType, handler);

      // Call connect() if the handler supports messaging
      if (typeof handler.connect === 'function') {
        handler.connect({
          sendMessage: (payload: unknown): void => {
            this.#sendHandlerMessage(handler.wireType, payload);
          },
        });
      }
    }

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
   * Send a handler message to the remote side.
   */
  #sendHandlerMessage(wireType: string, payload: unknown): void {
    const transfers: Array<Transferable> = [];
    this.#endpoint.postMessage(
      {
        type: 'handler-message',
        wireType,
        payload: this.#toWire(payload, '', transfers),
      },
      transfers,
    );
  }

  /**
   * Expose an object as the root service and send the ready signal.
   */
  expose(obj: object): void {
    this.#registerLocal(obj);
    this.#endpoint.postMessage({
      type: 'return',
      id: HANDSHAKE_ID,
      value: this.#makeProxyWire(obj),
    });
  }

  /**
   * Close the connection and stop listening for messages.
   */
  close(): void {
    this.#endpoint.removeEventListener('message', this.#handleMessage);

    // Call disconnect() on handlers that support it
    for (const handler of this.#handlers) {
      if (handler.disconnect) {
        handler.disconnect();
      }
    }
  }

  /**
   * Wait for the ready signal from the remote side.
   * Returns a proxy for the root service.
   */
  waitForReady(): Promise<unknown> {
    // Skip ID 0 on the wrap side - it's reserved for the root service on the
    // expose side. This ensures local IDs don't collide with remote IDs.
    this.#nextLocalId = 1;
    return new Promise((resolve, reject) => {
      this.#pendingCalls.set(HANDSHAKE_ID, {
        resolve,
        reject,
      });
    });
  }

  // ============================================================
  // Local object registry (strong refs, we expose to remote)
  // ============================================================

  /**
   * Register a local object and return its ID.
   */
  #registerLocal(obj: object): number {
    const existing = this.#localByObject.get(obj);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.#nextLocalId++;
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
  #toWire(
    value: unknown,
    path: string,
    transfers: Array<Transferable>,
  ): WireValue {
    // Check for proxy properties first
    if (isProxyProperty(value)) {
      const metadata = value[PROXY_PROPERTY_BRAND];
      return {
        [WIRE_TYPE]: 'proxy-property',
        targetProxyId: metadata.targetProxyId,
        property: metadata.property,
      };
    }

    // Transfer markers: add to transfer list and return raw value
    if (isTransferMarker(value)) {
      transfers.push(value.value);
      return value.value;
    }

    // LocalProxy markers are explicitly proxied
    if (isLocalProxy(value)) {
      return this.#makeProxyWire(value.value as object);
    }

    // Functions are always proxied
    if (typeof value === 'function') {
      return this.#makeProxyWire(value as object);
    }

    // Null and primitives are sent directly
    if (value === null || typeof value !== 'object') {
      return value;
    }

    // Check if this is a proxy we received from remote - send back original ID
    const existingId = this.#getRemoteId(value);
    if (existingId !== undefined) {
      return {[WIRE_TYPE]: 'proxy', proxyId: existingId};
    }

    // Promises get special handling
    if (isPromise(value)) {
      return this.#makePromiseWire(value);
    }

    // Check handlers (if any)
    if (this.#handlers.length > 0) {
      for (const handler of this.#handlers) {
        if (handler.canHandle(value)) {
          const ctx = this.#createToWireContext(path, transfers);
          return handler.toWire(value, ctx);
        }
      }
    }

    // Arrays: only traverse if nestedProxies, debug, or handlers exist
    if (Array.isArray(value)) {
      if (this.#nestedProxies || this.#debug || this.#handlers.length > 0) {
        return value.map((item, index) =>
          this.#processForClone(item, `${path}[${String(index)}]`, transfers),
        );
      }
      return value;
    }

    // Plain objects: only traverse if nestedProxies, debug, or handlers exist
    if (isPlainObject(value)) {
      if (this.#nestedProxies || this.#debug || this.#handlers.length > 0) {
        const processed: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
          processed[key] = this.#processForClone(
            (value as Record<string, unknown>)[key],
            path ? `${path}.${key}` : key,
            transfers,
          );
        }
        return processed;
      }
    }

    // Everything else (class instances, Date, RegExp, etc.): let structured
    // clone handle it. Users can use proxy() to explicitly proxy if needed.
    return value;
  }

  /**
   * Create a ToWireContext for handlers.
   */
  #createToWireContext(
    path: string,
    transfers: Array<Transferable>,
  ): ToWireContext {
    return {
      toWire: (value: unknown, key?: string | number): WireValue => {
        const subpath = key !== undefined ? String(key) : '';
        const fullPath =
          path && subpath ? `${path}.${subpath}` : path || subpath;
        return this.#toWire(value, fullPath, transfers);
      },
    };
  }

  /**
   * Create a WireProxy for a value.
   */
  #makeProxyWire(value: object) {
    const existingId = this.#getRemoteId(value);
    if (existingId !== undefined) {
      return {[WIRE_TYPE]: 'proxy', proxyId: existingId};
    }
    const proxyId = this.#registerLocal(value);
    return {[WIRE_TYPE]: 'proxy', proxyId};
  }

  /**
   * Create a WirePromise for a promise.
   */
  #makePromiseWire(value: Promise<unknown>) {
    const promiseId = this.#registerPromise(value);
    return {[WIRE_TYPE]: 'promise', promiseId};
  }

  /**
   * Process a value for inclusion in a cloned structure (nested mode or debug).
   * In nested mode: auto-proxy functions and promises, honor LocalProxy markers.
   * In debug mode: throw helpful errors for non-cloneable values.
   */
  #processForClone(
    value: unknown,
    path: string,
    transfers: Array<Transferable>,
  ): unknown {
    // Transfer markers: add to transfer list and return raw value
    if (isTransferMarker(value)) {
      transfers.push(value.value);
      return value.value;
    }

    // LocalProxy markers are explicitly proxied
    if (isLocalProxy(value)) {
      return this.#makeProxyWire(value.value as object);
    }

    // Functions are auto-proxied in nested mode
    if (typeof value === 'function') {
      if (!this.#nestedProxies) {
        throw new NonCloneableError('function', path);
      }
      return this.#makeProxyWire(value as object);
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    const existingId = this.#getRemoteId(value);
    if (existingId !== undefined) {
      return {[WIRE_TYPE]: 'proxy', proxyId: existingId};
    }

    // Promises are auto-proxied in nested mode
    if (isPromise(value)) {
      if (!this.#nestedProxies) {
        throw new NonCloneableError('promise', path);
      }
      return this.#makePromiseWire(value);
    }

    // Check handlers (if any)
    if (this.#handlers.length > 0) {
      for (const handler of this.#handlers) {
        if (handler.canHandle(value)) {
          const ctx = this.#createToWireContext(path, transfers);
          return handler.toWire(value, ctx);
        }
      }
    }

    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.#processForClone(item, `${path}[${String(index)}]`, transfers),
      );
    }

    if (isPlainObject(value)) {
      const processed: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        processed[key] = this.#processForClone(
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
          transfers,
        );
      }
      return processed;
    }

    // Class instance nested in a cloned structure - requires explicit proxy()
    // In nested mode without proxy(), this is an error (use proxy() explicitly)
    // In debug mode, we also throw to help the user understand what's wrong
    throw new NonCloneableError('class-instance', path);
  }

  // ============================================================
  // Wire value deserialization
  // ============================================================

  /**
   * Create a FromWireContext for handlers.
   */
  #createFromWireContext(): FromWireContext {
    return {
      fromWire: (wire: WireValue): unknown => this.#fromWire(wire),
    };
  }

  /**
   * Deserialize a value from wire format.
   */
  #fromWire(wire: WireValue): unknown {
    if (isWireProxy(wire)) {
      const existing =
        this.#getLocal(wire.proxyId) ?? this.#getRemote(wire.proxyId);
      if (existing) {
        return existing;
      }
      return this.#createRemoteProxy(wire.proxyId);
    }

    if (isWirePromise(wire)) {
      return this.#createRemotePromise(wire.promiseId);
    }

    // Check remaining wire types
    if (typeof wire === 'object' && wire !== null) {
      const w = wire as Record<string, unknown>;
      const wireType = w[WIRE_TYPE];

      if (wireType === 'proxy-property') {
        const pp = wire as WireProxyProperty;
        return this.#resolveProxyProperty(pp.targetProxyId, pp.property);
      }
      if (wireType === 'thrown') {
        throw deserializeError((wire as WireThrown).error);
      }

      // Check handler wireTypes
      if (typeof wireType === 'string') {
        const handler = this.#handlersByWireType.get(wireType);
        if (handler?.fromWire) {
          const ctx = this.#createFromWireContext();
          return handler.fromWire(wire, ctx);
        }
        // Handler exists but no fromWire — value is already correct type
        // (e.g., transferred stream arrives as stream)
      }
    }

    // Raw value - may contain nested markers if nestedProxies or handlers enabled
    if (!this.#nestedProxies && this.#handlers.length === 0) {
      return wire;
    }
    return this.#processFromClone(wire);
  }

  /**
   * Process a cloned value, replacing markers with actual objects.
   */
  #processFromClone(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (isWireProxy(value)) {
      const existing =
        this.#getLocal(value.proxyId) ?? this.#getRemote(value.proxyId);
      if (existing) {
        return existing;
      }
      return this.#createRemoteProxy(value.proxyId);
    }

    if (isWirePromise(value)) {
      return this.#createRemotePromise(value.promiseId);
    }

    // Check handler wireTypes
    const w = value as Record<string, unknown>;
    const wireType = w[WIRE_TYPE];
    if (typeof wireType === 'string') {
      const handler = this.#handlersByWireType.get(wireType);
      if (handler?.fromWire) {
        const ctx = this.#createFromWireContext();
        return handler.fromWire(value, ctx);
      }
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.#processFromClone(item));
    }

    // Only traverse plain objects ({...}) for nested wire markers.
    // Class instances and transferred objects (streams, etc.) have
    // non-Object prototypes, so isPlainObject returns false.
    if (!isPlainObject(value)) {
      return value;
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
        const transfers: Array<Transferable> = [];
        const wire = this.#toWire(value, '', transfers);
        this.#endpoint.postMessage(
          {
            type: 'promise-resolve',
            promiseId,
            value: wire,
          },
          transfers,
        );
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

      set: (_target, prop, value) => {
        if (typeof prop !== 'string') {
          return false;
        }
        // Fire-and-forget: initiate the set but don't block
        // The returned promise can be awaited if needed
        void this.#makeSet(proxyId, prop, value);
        return true;
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
    const transfers: Array<Transferable> = [];
    const wireArgs = args.map((arg) => this.#toWire(arg, '', transfers));
    const {promise, resolve, reject} = Promise.withResolvers<unknown>();
    const id = this.#nextCallId++;
    this.#pendingCalls.set(id, {resolve, reject});
    this.#endpoint.postMessage(
      {
        type: 'call',
        id,
        target,
        action: 'call',
        method,
        args: wireArgs,
      },
      transfers,
    );
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

  /**
   * Make a property SET request to the remote side.
   */
  #makeSet(
    target: number,
    property: string,
    value: unknown,
  ): Promise<undefined> {
    const transfers: Array<Transferable> = [];
    const wireValue = this.#toWire(value, '', transfers);
    const {promise, resolve, reject} = Promise.withResolvers<undefined>();
    const id = this.#nextCallId++;
    this.#pendingCalls.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    this.#endpoint.postMessage(
      {
        type: 'call',
        id,
        target,
        action: 'set',
        method: property,
        args: [wireValue],
      },
      transfers,
    );
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
            pending.resolve(this.#fromWire(message.value));
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
            call.resolve(this.#fromWire(message.value));
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
      case 'handler-message':
        this.#handleHandlerMessage(message.wireType, message.payload);
        break;
      default:
        // Exhaustiveness check
        message satisfies never;
    }
  }

  /**
   * Route a handler message to the appropriate handler.
   */
  #handleHandlerMessage(wireType: string, payload: WireValue): void {
    const handler = this.#handlersByWireType.get(wireType);
    if (handler?.onMessage) {
      try {
        const deserializedPayload = this.#fromWire(payload);
        const ctx = this.#createFromWireContext();
        handler.onMessage(deserializedPayload, ctx);
      } catch (error) {
        // Log errors from onMessage but don't propagate them
        // (there's no good place to send them - these are spontaneous messages)
        console.error(
          `Error in handler.onMessage for wireType "${wireType}":`,
          error,
        );
      }
    }
  }

  async #handleCall(message: CallMessage): Promise<void> {
    const {id, target, method, args, action} = message;

    // Deserialize arguments
    const deserializedArgs = args.map((arg) => this.#fromWire(arg));

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
      } else if (action === 'set') {
        if (method === undefined) {
          throw new TypeError('Property name required for set action');
        }
        (proxyTarget as Record<string, unknown>)[method] = deserializedArgs[0];
        result = undefined;
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

      const transfers: Array<Transferable> = [];
      const wire = this.#toWire(result, '', transfers);
      this.#endpoint.postMessage(
        {
          type: 'return',
          id,
          value: wire,
        },
        transfers,
      );
    } catch (error) {
      this.#endpoint.postMessage({
        type: 'throw',
        id,
        error: serializeError(error),
      });
    }
  }
}
