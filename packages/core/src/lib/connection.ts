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
  SerializedError,
  WireProxy,
} from './types.js';
import {isWireProxy, isWirePromise} from './types.js';
import {
  PROXY_PROPERTY_BRAND,
  PROXY_VALUE,
  WIRE_TYPE,
  HANDSHAKE_ID,
  NON_CLONEABLE,
} from './constants.js';
import {
  isProxyMarker,
  isOpaqueMarker,
  isProxyProperty,
  isPromise,
  isTransferMarker,
  serializeError,
  deserializeError,
  NonCloneableError,
  proxy,
} from './protocol.js';

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

  #nextId = 0;

  // Local object registry (strong refs) - objects we expose to remote
  #localById = new Map<number, object>();
  #localByObject = new WeakMap<object, number>();

  // Remote proxy cache (weak refs) - proxies we received from remote
  #remoteProxyById = new Map<number, WeakRef<object>>();
  #remoteProxyByObject = new WeakMap<object, number>();
  #remoteCleanup: FinalizationRegistry<number>;

  // Pending RPC calls awaiting response
  #pendingCalls = new Map<number, PendingCall>();

  // Promise tracking
  #pendingRemotePromises = new Map<number, PendingCall>();

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
    this.#remoteCleanup = new FinalizationRegistry((id: number) => {
      this.#remoteProxyById.delete(id);
      this.#post({type: 'release', id});
    });

    // Bind and attach message handler
    // this.#handleMessage = this.#onMessage.bind(this);
    endpoint.addEventListener('message', this.#onMessage);
  }

  #post(message: unknown, transfer?: Array<Transferable>): void {
    this.#endpoint.postMessage(message, transfer);
  }

  /**
   * Send a handler message to the remote side.
   */
  #sendHandlerMessage(wireType: string, payload: unknown): void {
    const transfers: Array<Transferable> = [];
    this.#post(
      {
        type: 'handler',
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
    this.#post({
      type: 'return',
      id: HANDSHAKE_ID,
      value: this.#makeProxyWire(obj),
    });
  }

  /**
   * Close the connection and stop listening for messages.
   */
  close(): void {
    this.#endpoint.removeEventListener('message', this.#onMessage);

    // Call disconnect() on handlers that support it
    for (const handler of this.#handlers) {
      handler.disconnect?.();
    }
  }

  /**
   * Wait for the ready signal from the remote side.
   * Returns a proxy for the root service.
   */
  waitForReady(): Promise<unknown> {
    // Skip ID 0 on the wrap side - it's reserved for the root service on the
    // expose side. This ensures local IDs don't collide with remote IDs.
    this.#nextId = 1;
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
    let id = this.#localByObject.get(obj);
    if (id !== undefined) {
      return id;
    }
    id = this.#nextId++;
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

  // ============================================================
  // Remote proxy/handle cache (weak refs)
  // ============================================================

  /**
   * Get the remote proxy for an ID, if still alive.
   */
  #getRemoteProxy(id: number): object | undefined {
    return this.#remoteProxyById.get(id)?.deref();
  }

  /**
   * Get the remote ID for a proxy, if it exists.
   */
  #getRemoteProxyId(obj: object): number | undefined {
    return this.#remoteProxyByObject.get(obj);
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
    // Handle top-level-only wire types
    if (isProxyProperty(value)) {
      return {
        [WIRE_TYPE]: 'property',
        ...value[PROXY_PROPERTY_BRAND],
      };
    }
    // Delegate all other value handling to processForClone
    // Pass a Map to track cycles when recursing in debug/nested mode
    return this.#processForClone(value, path, transfers, new Map());
  }

  /**
   * Create a WireProxy for a value.
   */
  #makeProxyWire(value: object, opaque = false): WireProxy {
    return {
      [WIRE_TYPE]: 'proxy',
      id: this.#getRemoteProxyId(value) ?? this.#registerLocal(value),
      o: opaque,
    };
  }

  /**
   * Process a value for wire serialization.
   * Handles markers, recursion, and debug mode errors.
   * @param seen - Map tracking visited objects to their processed results (for cycle detection)
   */
  #processForClone(
    value: unknown,
    path: string,
    transfers: Array<Transferable>,
    seen: Map<object, unknown>,
  ): unknown {
    // Null and primitives are sent directly
    if (
      value == null ||
      (typeof value !== 'object' && typeof value !== 'function')
    ) {
      return value;
    }

    // Check for cycles - return cached result if we've seen this object.
    // This must happen before any other object processing to avoid:
    // - Creating duplicate wire proxies for the same object
    // - Registering the same promise multiple times with different IDs
    const cached = seen.get(value);
    if (cached !== undefined) {
      return cached;
    }

    // Transfer markers: add to transfer list and return raw value
    if (isTransferMarker(value)) {
      if (path && this.#debug && !this.#nestedProxies) {
        throw new NonCloneableError('transfer', path);
      }
      transfers.push(value.value);
      return value.value;
    }

    // Proxy markers - extract the underlying value
    if (isProxyMarker(value)) {
      if (path && this.#debug && !this.#nestedProxies) {
        throw new NonCloneableError('proxy', path);
      }
      const wire = this.#makeProxyWire(
        (value as {[PROXY_VALUE]: object})[PROXY_VALUE],
        isOpaqueMarker(value),
      );
      seen.set(value as object, wire);
      return wire;
    }

    // Functions are always proxied (or throw in debug-only mode)
    if (typeof value === 'function') {
      if (this.#debug && !this.#nestedProxies) {
        throw new NonCloneableError('function', path);
      }
      const wire = this.#makeProxyWire(value as object);
      seen.set(value as object, wire);
      return wire;
    }

    // Check if this is a proxy we received from remote
    if (this.#getRemoteProxyId(value) !== undefined) {
      const wire = this.#makeProxyWire(value, '__o' in value);
      seen.set(value, wire);
      return wire;
    }

    // Promises are proxied (or throw in debug-only mode)
    if (isPromise(value)) {
      if (this.#debug && !this.#nestedProxies) {
        throw new NonCloneableError('promise', path);
      }
      const wire = {[WIRE_TYPE]: 'promise', id: this.#registerPromise(value)};
      seen.set(value, wire);
      return wire;
    }

    // Check handlers
    if (this.#handlers.length > 0) {
      for (const handler of this.#handlers) {
        if (handler.canHandle(value)) {
          const ctx: ToWireContext = {
            toWire: (v: unknown, key?: string): WireValue => {
              const p = key ? (path ? `${path}.${key}` : key) : path;
              return this.#processForClone(v, p, transfers, seen);
            },
          };
          const wire = handler.toWire(value, ctx);
          seen.set(value, wire);
          return wire;
        }
      }
    }

    // Decide whether to recurse into arrays/objects
    const shouldRecurse = this.#nestedProxies || this.#debug;

    if (!shouldRecurse) {
      return value;
    }

    if (Array.isArray(value)) {
      const processed: Array<unknown> = [];
      seen.set(value, processed); // Cache before recursing to handle cycles
      for (let i = 0; i < value.length; i++) {
        processed.push(
          this.#processForClone(
            value[i],
            `${path}[${String(i)}]`,
            transfers,
            seen,
          ),
        );
      }
      return processed;
    }

    // Only recurse into plain objects (prototype is Object.prototype or null).
    // All other objects (Map, Set, Date, class instances, etc.) pass through
    // for structured clone to handle natively.

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const processed: Record<string, unknown> = {};
      seen.set(value, processed); // Cache before recursing to handle cycles
      for (const key of Object.keys(value)) {
        processed[key] = this.#processForClone(
          (value as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
          transfers,
          seen,
        );
      }
      return processed;
    }

    return value;
  }

  // ============================================================
  // Wire value deserialization
  // ============================================================

  /**
   * Create a FromWireContext that shares a seen map for cycle detection.
   */
  #makeFromWireContext(seen: Map<object, unknown>): FromWireContext {
    return {
      fromWire: (wire: WireValue): unknown =>
        this.#processFromClone(wire, seen),
    };
  }

  /**
   * Deserialize a value from wire format.
   */
  #fromWire(wire: WireValue): unknown {
    // Handle top-level-only wire types first
    const wireType = (wire as Record<string, unknown> | null)?.[WIRE_TYPE];
    if (wireType === 'property') {
      const pp = wire as WireProxyProperty;
      const target = this.#getLocal(pp.targetProxyId);
      if (!target) {
        throw new ReferenceError(
          `Proxy property target ${String(pp.targetProxyId)} not found`,
        );
      }
      return (target as Record<string, unknown>)[pp.property];
    }
    if (wireType === 'thrown') {
      throw deserializeError((wire as WireThrown).error);
    }

    // Delegate all other wire value handling to processFromClone
    // Pass a Map to track cycles when recursing in nested mode
    return this.#processFromClone(wire, new Map());
  }

  /**
   * Process a value from wire format, handling markers and recursion.
   * @param seen - Map tracking visited objects to their processed results (for cycle detection)
   */
  #processFromClone(value: unknown, seen: Map<object, unknown>): unknown {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    // Check for cycles - return cached result if we've seen this object.
    // This must happen before any other object processing.
    const cached = seen.get(value);
    if (cached !== undefined) {
      return cached;
    }

    if (isWireProxy(value)) {
      const local = this.#getLocal(value.id);
      if (local) {
        const result = proxy(local, value.o);
        seen.set(value, result);
        return result;
      }
      const result =
        this.#getRemoteProxy(value.id) ??
        this.#createRemoteProxy(value.id, value.o);
      seen.set(value, result);
      return result;
    }

    if (isWirePromise(value)) {
      const {promise, resolve, reject} = Promise.withResolvers<unknown>();
      this.#pendingRemotePromises.set(value.id, {resolve, reject});
      seen.set(value, promise);
      return promise;
    }

    // Check handler wireTypes
    const wireType = (value as Record<string, unknown>)[WIRE_TYPE];
    if (typeof wireType === 'string') {
      const handler = this.#handlersByWireType.get(wireType);
      if (handler?.fromWire) {
        const result = handler.fromWire(value, this.#makeFromWireContext(seen));
        seen.set(value, result);
        return result;
      }
    }

    // Only recurse if nestedProxies enabled
    if (!this.#nestedProxies) {
      return value;
    }

    if (Array.isArray(value)) {
      const processed: Array<unknown> = [];
      seen.set(value, processed); // Cache before recursing to handle cycles
      for (const item of value) {
        processed.push(this.#processFromClone(item, seen));
      }
      return processed;
    }

    // Only recurse into plain objects. This protects:
    // - Built-in types preserved by structured clone (ReadableStream, etc.)
    // - Objects returned by handlers (which may be class instances)
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return value;
    }

    const processed: Record<string, unknown> = {};
    seen.set(value, processed); // Cache before recursing to handle cycles
    for (const key of Object.keys(value)) {
      processed[key] = this.#processFromClone(
        (value as Record<string, unknown>)[key],
        seen,
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
    const id = this.#nextId++;
    promise.then(
      (value) => {
        const transfers: Array<Transferable> = [];
        const wire = this.#toWire(value, '', transfers);
        this.#post(
          {
            type: 'resolve',
            id,
            value: wire,
          },
          transfers,
        );
      },
      (error: unknown) => {
        this.#post({
          type: 'reject',
          id,
          error: serializeError(error),
        });
      },
    );
    return id;
  }

  // ============================================================
  // Remote proxy creation
  // ============================================================

  /**
   * Create a proxy for a remote object.
   * Opaque proxies are simple objects (no JS Proxy overhead).
   */
  #createRemoteProxy(id: number, opaque?: boolean): object {
    let proxy = this.#getRemoteProxy(id);
    if (proxy === undefined) {
      proxy = opaque
        ? // Opaque: simple non-cloneable object (handle)
          {__o: NON_CLONEABLE}
        : // Full proxy with property/method access
          new Proxy(NON_CLONEABLE as object, {
            apply: (_target, _thisArg, args: Array<unknown>) =>
              this.#makeCall(id, undefined, args),

            get: (_target, prop) =>
              // Not thenable at top level (prevents auto-await issues)
              typeof prop === 'string' && prop !== 'then'
                ? this.#createProxyProperty(id, prop)
                : undefined,

            set: (_target, prop, value) => {
              if (typeof prop !== 'string') return false;
              const transfers: Array<Transferable> = [];
              void this.#sendCall(
                id,
                'set',
                prop,
                [this.#toWire(value, '', transfers)],
                transfers,
              );
              return true;
            },
          });
      this.#remoteProxyById.set(id, new WeakRef(proxy));
      this.#remoteProxyByObject.set(proxy, id);
      this.#remoteCleanup.register(proxy, id);
    }
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
      return this.#sendCall(target, 'get', prop, [], []).then(
        onfulfilled,
        onrejected,
      );
    };

    (callable as ProxyProperty)[PROXY_PROPERTY_BRAND] = {
      targetProxyId: target,
      property: prop,
    };

    return callable as ProxyProperty;
  }

  // ============================================================
  // RPC primitives
  // ============================================================

  /**
   * Send a call message and return a promise for the response.
   */
  #sendCall(
    target: number,
    action: 'call' | 'get' | 'set',
    method: string | undefined,
    args: Array<unknown>,
    transfers: Array<Transferable>,
  ): Promise<unknown> {
    const {promise, resolve, reject} = Promise.withResolvers<unknown>();
    const id = this.#nextId++;
    this.#pendingCalls.set(id, {resolve, reject});
    this.#post({type: 'call', id, target, action, method, args}, transfers);
    return promise;
  }

  #makeCall(
    target: number,
    method: string | undefined,
    args: Array<unknown>,
  ): Promise<unknown> {
    const transfers: Array<Transferable> = [];
    // Share seen map across all args to preserve identity for shared references
    const seen = new Map<object, unknown>();
    return this.#sendCall(
      target,
      'call',
      method,
      args.map((arg) => this.#processForClone(arg, '', transfers, seen)),
      transfers,
    );
  }

  // ============================================================
  // Message handling
  // ============================================================

  #onMessage = async (event: MessageEvent<Message>): Promise<void> => {
    const message = event.data;
    if ((message as unknown) == null) {
      return;
    }

    switch (message.type) {
      case 'release': {
        // Unified release for both proxies and handles
        const obj = this.#localById.get(message.id);
        if (obj !== undefined) {
          this.#localById.delete(message.id);
          this.#localByObject.delete(obj);
        }
        break;
      }
      case 'resolve':
        this.#settlePending(
          this.#pendingRemotePromises,
          message.id,
          message.value,
        );
        break;
      case 'reject':
        this.#rejectPending(
          this.#pendingRemotePromises,
          message.id,
          message.error,
        );
        break;
      case 'return':
        this.#settlePending(this.#pendingCalls, message.id, message.value);
        break;
      case 'throw':
        this.#rejectPending(this.#pendingCalls, message.id, message.error);
        break;
      case 'call':
        await this.#handleCall(message);
        break;
      case 'handler':
        this.#handleHandlerMessage(message.wireType, message.payload);
        break;
      default:
        // Exhaustiveness check
        message satisfies never;
    }
  };

  #settlePending(
    map: Map<number, PendingCall>,
    id: number,
    value: WireValue,
  ): void {
    const pending = map.get(id);
    if (pending) {
      map.delete(id);
      try {
        pending.resolve(this.#fromWire(value));
      } catch (error) {
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  #rejectPending(
    map: Map<number, PendingCall>,
    id: number,
    error: SerializedError,
  ): void {
    const pending = map.get(id);
    if (pending) {
      map.delete(id);
      pending.reject(deserializeError(error));
    }
  }

  /**
   * Route a handler message to the appropriate handler.
   */
  #handleHandlerMessage(wireType: string, payload: WireValue): void {
    try {
      const handler = this.#handlersByWireType.get(wireType);
      if (handler?.onMessage) {
        const seen = new Map<object, unknown>();
        handler.onMessage(
          this.#processFromClone(payload, seen),
          this.#makeFromWireContext(seen),
        );
      }
    } catch (error) {
      // Log errors from onMessage but don't propagate them
      // (there's no good place to send them - these are spontaneous messages)
      console.error(
        `Error in handler.onMessage for wireType "${wireType}":`,
        error,
      );
    }
  }

  async #handleCall(message: CallMessage): Promise<void> {
    const {id, target, method, args, action} = message;

    // Deserialize arguments with shared seen map to preserve identity
    const seen = new Map<object, unknown>();
    const deserializedArgs = args.map((arg) =>
      this.#processFromClone(arg, seen),
    );

    // Look up the target object
    const proxyTarget = this.#getLocal(target);
    if (!proxyTarget) {
      return this.#post({
        type: 'throw',
        id,
        error: {
          name: 'ReferenceError',
          message: `Proxy target ${String(target)} not found`,
        },
      });
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
      this.#post({type: 'return', id, value: wire}, transfers);
    } catch (error) {
      this.#post({type: 'throw', id, error: serializeError(error)});
    }
  }
}
