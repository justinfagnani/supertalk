/**
 * Core type definitions for Supertalk.
 *
 * This file contains:
 * - Type definitions and interfaces (Endpoint, Options, Message, etc.)
 * - Type guards for wire value detection
 *
 * Constants live in constants.ts. Runtime utilities like `proxy()`, error
 * classes, and serialization helpers live in protocol.ts.
 *
 * @fileoverview Type definitions for the wire protocol.
 */

import {WIRE_TYPE, type PROXY_VALUE} from './constants.js';

// ============================================================
// Endpoint interface
// ============================================================

/**
 * An Endpoint is any object that can send and receive messages.
 * This abstracts over Worker, MessagePort, Window, etc.
 */
export interface Endpoint {
  postMessage(message: unknown, transfer?: Array<Transferable>): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: Array<any>) => any;

// ============================================================
// AsyncProxy type (unified local/remote proxy)
// ============================================================

/**
 * An async proxy to a value, usable on both sides of a connection.
 *
 * Use `proxy(value)` to create an AsyncProxy. On both the local and remote
 * side, the proxy provides an async interface for property/method access.
 *
 * - Use `getProxyValue(proxy)` to get the underlying value on the owning side
 * - The remote side can call methods and access properties asynchronously
 * - AsyncProxies do NOT auto-unwrap when sent back — they stay as proxies
 *
 * The same `AsyncProxy<T>` type is used on both sides, enabling consistent
 * APIs that work identically in and out of workers.
 *
 * @example
 * ```ts
 * // Service implementation
 * class MyService {
 *   createWidget(): AsyncProxy<Widget> {
 *     return proxy(new Widget());
 *   }
 *
 *   updateWidget(widget: AsyncProxy<Widget>): void {
 *     // Get the underlying value on the owning side
 *     const w = getProxyValue(widget);
 *     w.refresh();
 *   }
 * }
 *
 * // Client usage (same types locally and remotely)
 * const widget = await service.createWidget();  // AsyncProxy<Widget>
 * await widget.name;        // Property access is async
 * await widget.activate();  // Method calls are async
 * await service.updateWidget(widget);  // Pass proxy back
 * ```
 */
export type AsyncProxy<T> = {
  /**
   * Brand to identify proxy objects. Contains the underlying value on the
   * owning side, undefined on the remote side.
   * @internal - Use getProxyValue() to access the value
   */
  readonly [PROXY_VALUE]?: T;
} & {
  [K in keyof T]: T[K] extends AnyFunction
    ? (...args: Parameters<T[K]>) => Promise<Awaited<Remoted<ReturnType<T[K]>>>>
    : Promise<Awaited<Remoted<T[K]>>>;
};

// ============================================================
// Handle type (opaque reference)
// ============================================================

/**
 * An opaque handle to a value, usable on both sides of a connection.
 *
 * Use `handle(value)` to create a Handle. Unlike refs, handles provide
 * NO interface for accessing the underlying value remotely — they are
 * completely opaque tokens.
 *
 * - Use `getHandleValue(handle)` to get the underlying value on the owning side
 * - Handles are useful when you need consistent APIs but don't need remote access
 * - Handles do NOT auto-unwrap when sent back — they stay as handles
 *
 * Handles are essentially refs without the async interface, useful for
 * opaque tokens, session identifiers, or references to expensive objects.
 *
 * @example
 * ```ts
 * // Service implementation
 * class MyService {
 *   createSession(id: string): Handle<Session> {
 *     return handle(new Session(id));
 *   }
 *
 *   getSessionName(session: Handle<Session>): string {
 *     // Get the underlying value on the owning side
 *     const s = getHandleValue(session);
 *     return s.name;
 *   }
 * }
 *
 * // Client usage (same types locally and remotely)
 * const session = await service.createSession('abc');  // Handle<Session>
 * // session is opaque — can't access properties
 * const name = await service.getSessionName(session);  // Pass handle back
 * ```
 */
export interface Handle<T> {
  /**
   * Brand to identify handle objects. Contains the underlying value on the
   * owning side, undefined on the remote side.
   * @internal - Use getHandleValue() to access the value
   */
  readonly [PROXY_VALUE]?: T;
  /**
   * Discriminator to distinguish handles from refs at the type level.
   * @internal
   */
  readonly __handle: true;
}

// ============================================================
// Remote service types
// ============================================================

/**
 * Converts a type T to its "remote" version where methods return Promises
 * and properties become Promise-wrapped.
 *
 * Use this type for the return value of `wrap()`. Methods become async,
 * return values are transformed via `Remoted<T>`, and non-function properties
 * become Promises.
 *
 * @example
 * ```ts
 * interface MyService {
 *   readonly count: number;
 *   add(a: number, b: number): number;
 *   createWidget(): AsyncProxy<Widget>;
 *   getData(): { value: number };
 * }
 *
 * const remote = wrap<MyService>(worker);
 * // Remote<MyService> = {
 * //   count: Promise<number>;
 * //   add(a: number, b: number): Promise<number>;
 * //   createWidget(): Promise<AsyncProxy<Widget>>;
 * //   getData(): Promise<{ value: number }>;
 * // }
 * ```
 */
export type Remote<T> = {
  [K in keyof T]: T[K] extends AnyFunction
    ? (...args: Parameters<T[K]>) => Promise<Awaited<Remoted<ReturnType<T[K]>>>>
    : Promise<Awaited<Remoted<T[K]>>>;
};

/**
 * Recursively transforms a type for remote access.
 *
 * - `AsyncProxy<T>` stays as `AsyncProxy<T>` (same type on both sides)
 * - `Handle<T>` stays as `Handle<T>` (same type on both sides)
 * - Functions → async functions
 * - Arrays → recurse into elements
 * - Objects → recurse into properties
 * - Primitives → unchanged
 *
 * @example
 * ```ts
 * // AsyncProxy stays as AsyncProxy (consistent on both sides)
 * type T1 = Remoted<AsyncProxy<Widget>>;  // AsyncProxy<Widget>
 *
 * // Handle stays as Handle (consistent on both sides)
 * type T2 = Remoted<Handle<Token>>;  // Handle<Token>
 *
 * // Functions become async
 * type T3 = Remoted<() => number>;  // () => Promise<number>
 *
 * // Objects recurse
 * type T4 = Remoted<{ fn: () => void }>;  // { fn: () => Promise<void> }
 * ```
 */
export type Remoted<T> =
  T extends AsyncProxy<infer _U>
    ? T // AsyncProxy stays as-is (same type on both sides)
    : T extends Handle<infer _U>
      ? T // Handle stays as-is (same type on both sides)
      : T extends AnyFunction
        ? (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>
        : T extends Array<infer U>
          ? Array<Remoted<U>>
          : T extends object
            ? {[K in keyof T]: Remoted<T[K]>}
            : T;

/**
 * Message types for the wire protocol.
 *
 * Note: `id: 0` is reserved for the initialization handshake. The exposed side
 * sends a ReturnMessage with id 0 containing the root proxy when ready, or a
 * ThrowMessage with id 0 if initialization fails.
 */
export type Message =
  | CallMessage
  | ReturnMessage
  | ThrowMessage
  | ReleaseMessage
  | PromiseResolveMessage
  | PromiseRejectMessage
  | HandlerMessage;

/**
 * Action type for CallMessage.
 *
 * - 'call': Invoke a method or function with arguments
 * - 'get': Get a property value (method must be property name)
 * - 'set': Set a property value (method must be property name, args[0] is value)
 */
export type CallAction = 'call' | 'get' | 'set';

/**
 * Call a method on a target object, invoke a function, get/set a property.
 *
 * - target: proxy ID of the target object
 * - action: 'call' to invoke, 'get' to get property, 'set' to set property
 * - method: method/property name, or undefined for direct function invocation
 */
export interface CallMessage {
  type: 'call';
  id: number;
  target: number;
  action: CallAction;
  method: string | undefined;
  args: Array<WireValue>;
}

export interface ReturnMessage {
  type: 'return';
  id: number;
  value: WireValue;
}

export interface ThrowMessage {
  type: 'throw';
  id: number;
  error: SerializedError;
}

/**
 * Release a proxy or handle, allowing the source to garbage collect the target.
 */
export interface ReleaseMessage {
  type: 'release';
  id: number;
}

/**
 * Resolve a promise that was sent to the remote side.
 */
export interface PromiseResolveMessage {
  type: 'resolve';
  id: number;
  value: WireValue;
}

/**
 * Reject a promise that was sent to the remote side.
 */
export interface PromiseRejectMessage {
  type: 'reject';
  id: number;
  error: SerializedError;
}

/**
 * Message sent between handlers on different sides of a connection.
 * Used for subscription updates, backpressure, releases, etc.
 */
export interface HandlerMessage {
  type: 'handler';
  /** Routes to the handler with matching wireType */
  wireType: string;
  /** Handler-defined payload, serialized through toWire/fromWire */
  payload: WireValue;
}

/**
 * Serialized error format for transmission.
 */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/**
 * Options for configuring expose() and wrap().
 */
export interface Options {
  /**
   * Enable nested proxy handling.
   *
   * When `false` (default, "shallow mode"): Only top-level function arguments
   * are proxied. Functions, promises, or `proxy()` markers nested in objects
   * will fail with `DataCloneError`. Maximum performance, predictable behavior.
   *
   * When `true` ("nested mode"): Full payload traversal on send and receive.
   * Functions and promises are auto-proxied wherever found. Objects wrapped
   * with `proxy()` are converted to wire proxies.
   *
   * @default false
   */
  nestedProxies?: boolean;

  /**
   * Enable debug mode for better error messages.
   *
   * When `true` and `nestedProxies` is `false`, performs payload traversal to
   * detect non-cloneable values and throw a helpful `NonCloneableError` with
   * the path to the problematic value (e.g., "options.onChange").
   *
   * Has no effect when `nestedProxies` is `true` (traversal happens anyway).
   *
   * @default false
   */
  debug?: boolean;

  /**
   * Custom handlers for serialization/deserialization.
   *
   * Handlers are checked in order during serialization. First handler whose
   * `canHandle()` returns true wins. Both sides of a connection must use
   * compatible handlers.
   *
   * @example
   * ```ts
   * expose(service, endpoint, { handlers: [mapHandler, streamHandler] });
   * wrap<Service>(endpoint, { handlers: [mapHandler, streamHandler] });
   * ```
   */
  handlers?: Array<Handler>;
}

/**
 * Wire format for values that may contain proxy references.
 *
 * Special values (proxies, promises, etc.) are branded with `__supertalk_type__`.
 * Raw values (primitives, plain objects, arrays) are sent as-is without wrapping.
 * On receive, we check for the brand - if absent, the value is raw user data.
 *
 * This is typed as `unknown` because raw values can be anything. The specific
 * wire marker types (WireProxy, WirePromise, etc.) are discriminated by WIRE_TYPE.
 */
export type WireValue = unknown;

export interface WireProxy {
  [WIRE_TYPE]: 'proxy';
  id: number;
  /** Opaque flag - proxy is a handle with no property access */
  o: boolean;
}

export interface WirePromise {
  [WIRE_TYPE]: 'promise';
  id: number;
}

export interface WireProxyProperty {
  [WIRE_TYPE]: 'property';
  targetProxyId: number;
  property: string;
}

export interface WireThrown {
  [WIRE_TYPE]: 'thrown';
  error: SerializedError;
}

// Type guards for wire values
// Shared helper casts value to record after null/object check

export function isWireProxy(value: unknown): value is WireProxy {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return (value as WireProxy)?.[WIRE_TYPE] === 'proxy';
}

export function isWirePromise(value: unknown): value is WirePromise {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return (value as WirePromise)?.[WIRE_TYPE] === 'promise';
}

/**
 * Metadata stored on proxy properties for detection and serialization.
 */
export interface ProxyPropertyMetadata {
  targetProxyId: number;
  property: string;
}

// ============================================================
// Handler types
// ============================================================

/**
 * Context provided to handler toWire methods.
 *
 * Handlers use `toWire()` to convert nested values. Combine with
 * the public marker APIs for special handling:
 * - `ctx.toWire(proxy(obj))` — proxy an object
 * - `ctx.toWire(transfer(stream))` — add to transfer list
 * - `ctx.toWire(value, key)` — process with path tracking
 */
export interface ToWireContext {
  /**
   * Recursively convert a nested value to wire format.
   * Applies handlers and default behavior, returns wire-safe value.
   * @param value - The value to convert (may be wrapped with proxy()/transfer())
   * @param key - Optional key for error path building (e.g., 'name', '0')
   */
  toWire(value: unknown, key?: string): WireValue;
}

/**
 * Context provided to handler fromWire methods.
 */
export interface FromWireContext {
  /**
   * Recursively convert a nested wire value back to its original form.
   * Handles proxies, promises, and nested handler values.
   */
  fromWire(wire: WireValue): unknown;
}

/**
 * Context provided to handlers when connected to a connection.
 * Allows handlers to send messages to their remote counterpart.
 */
export interface HandlerConnectionContext {
  /**
   * Send a message to the handler with the same wireType on the remote side.
   * The payload goes through toWire serialization, so nested values
   * (including functions with nestedProxies) are handled correctly.
   */
  sendMessage(payload: unknown): void;
}

/**
 * A pluggable handler for custom serialization/deserialization.
 *
 * Handlers can transform values during wire transmission. Use cases:
 * - Collections: Maps, Sets as proxies or cloned
 * - Streams: ReadableStream/WritableStream transferred
 * - Custom types: Domain-specific serialization
 *
 * Handlers may also implement lifecycle methods for subscription-oriented
 * data types (signals, streams, observables):
 * - `connect()` — Called when attached to a connection, provides messaging context
 * - `onMessage()` — Called when a message arrives for this handler's wireType
 * - `disconnect()` — Called when the connection closes
 *
 * @typeParam T - The type this handler handles (e.g., Map<K, V>)
 * @typeParam W - The wire format type (must extend object with WIRE_TYPE)
 */
export interface Handler<T = unknown, W extends object = object> {
  /**
   * Unique wire type identifier for this handler.
   * Used to route deserialization and handler messages.
   * Convention: 'signal', 'stream', '<package>:<name>', 'app:<name>'
   */
  wireType: string;

  /**
   * Fast check if this handler applies to a value.
   * Called during serialization. Return true to handle, false to skip.
   * First registered handler that returns true wins.
   */
  canHandle(value: unknown): value is T;

  /**
   * Convert the value to wire format.
   *
   * Use context methods to build wire values:
   * - ctx.toWire(proxy(value)) — proxy the value
   * - ctx.toWire(value, key) — recursively process nested values
   * - ctx.toWire(transfer(value)) — add to transfer list
   *
   * Return either:
   * - A wire value from a context method
   * - A custom wire object with [WIRE_TYPE] set to this handler's wireType
   */
  toWire(value: T, ctx: ToWireContext): WireValue;

  /**
   * Convert a value from wire format.
   * Only called for values with matching wireType.
   * Optional — not needed for proxied or transferred values.
   */
  fromWire?(wire: W, ctx: FromWireContext): T;

  /**
   * Called when the handler is attached to a connection.
   * Use this to store the context for sending messages later.
   * Optional — only needed for subscription-oriented handlers.
   */
  connect?(ctx: HandlerConnectionContext): void;

  /**
   * Called when a message arrives for this handler's wireType.
   * The payload has already been deserialized through fromWire.
   * Optional — only needed for subscription-oriented handlers.
   */
  onMessage?(payload: unknown, ctx: FromWireContext): void;

  /**
   * Called when the connection closes.
   * Use this to clean up resources (unwatching signals, closing streams, etc.).
   * Optional — only needed for subscription-oriented handlers.
   */
  disconnect?(): void;
}
