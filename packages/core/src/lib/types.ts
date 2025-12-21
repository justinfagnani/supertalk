/**
 * Core type definitions for supertalk.
 *
 * @packageDocumentation
 */

// ============================================================
// Wire protocol constants
// ============================================================

/**
 * Wire type discriminator property name.
 * This serves as both a brand and type discriminator - user objects won't
 * accidentally have `__supertalk_type__: 'proxy'` etc.
 */
export const WIRE_TYPE = '__supertalk_type__';

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

/**
 * Converts a type T to its "remote" version where all methods return Promises.
 *
 * @typeParam T - The service type to transform
 * @typeParam ProxiedTypes - Optional tuple of types that should be treated as
 *   proxied (get `Proxied<T>` treatment with async properties). If omitted,
 *   only functions are transformed to async; object properties stay as-is.
 * @typeParam ExcludedTypes - Optional tuple of types that should NOT be proxied
 *   even if they match something in ProxiedTypes. Useful for plain object types
 *   that happen to structurally match a proxied class.
 *
 * ## Gotchas
 *
 * TypeScript uses structural typing, so it cannot distinguish between a class
 * instance and a plain object with the same shape. If a method can return either:
 *
 * ```ts
 * getWidget(): Widget  // Could be `new WidgetClass()` OR `{ name, activate }`
 * ```
 *
 * And you list `Widget` in ProxiedTypes, plain object returns will be typed
 * incorrectly (as Proxied) even though they're cloned at runtime.
 *
 * **Solutions:**
 * 1. Use distinct types for plain objects vs class instances
 * 2. Use ExcludedTypes to carve out exceptions
 * 3. Only list concrete class types, not interfaces they implement
 *
 * @example
 * ```ts
 * class Counter {
 *   name: string;
 *   increment(): number { ... }
 * }
 *
 * interface Service {
 *   createCounter(): Counter;
 *   getData(): { value: number };
 * }
 *
 * // Declare Counter as a proxied type
 * type MyRemote = Remote<Service, [Counter]>;
 *
 * const counter = await remote.createCounter();
 * await counter.name;       // ✓ Promise<string> (proxied)
 * await counter.increment(); // ✓ Promise<number>
 *
 * const data = await remote.getData();
 * data.value; // ✓ number (plain object, not proxied)
 * ```
 *
 * @example
 * ```ts
 * // Using ExcludedTypes to handle structural overlap
 * interface WidgetData { name: string; active: boolean }
 * class Widget { name: string; active: boolean; activate() {} }
 *
 * // WidgetData structurally matches Widget, so exclude it
 * type MyRemote = Remote<Service, [Widget], [WidgetData]>;
 * ```
 */
export type Remote<
  T,
  ProxiedTypes extends Array<unknown> = [],
  ExcludedTypes extends Array<unknown> = [],
> = {
  [K in keyof T as T[K] extends AnyFunction ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<Remoted<R, ProxiedTypes, ExcludedTypes>>>
    : never;
};

/**
 * Converts a type T to its "remote" version with full recursive transformation.
 *
 * @typeParam T - The service type to transform
 * @typeParam ProxiedTypes - Optional tuple of types that should be treated as
 *   proxied (get `Proxied<T>` treatment with async properties).
 * @typeParam ExcludedTypes - Optional tuple of types to exclude from proxying.
 *
 * In autoProxy mode:
 * - Top-level methods become async
 * - Nested functions in return values also become async
 * - Types in ProxiedTypes get full proxy treatment (properties async)
 * - Types in ExcludedTypes are NOT proxied even if they match ProxiedTypes
 * - Arguments accept both original types and their remoted versions
 *   (since proxied objects sent back are unwrapped to originals)
 *
 * @example
 * ```ts
 * interface Service {
 *   createWidget(): { activate: () => string };
 * }
 * // RemoteAutoProxy<Service>.createWidget returns:
 * // Promise<{ activate: () => Promise<string> }>
 * ```
 */
export type RemoteAutoProxy<
  T,
  ProxiedTypes extends Array<unknown> = [],
  ExcludedTypes extends Array<unknown> = [],
> = {
  [K in keyof T as T[K] extends AnyFunction ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (
        ...args: RemotedArgs<A, ProxiedTypes, ExcludedTypes>
      ) => Promise<Awaited<Remoted<R, ProxiedTypes, ExcludedTypes>>>
    : never;
};

/**
 * Transform argument types to accept either original or remoted versions.
 * This handles the round-trip case where a proxied object is passed back
 * and gets unwrapped to the original.
 */
type RemotedArgs<
  T extends Array<unknown>,
  ProxiedTypes extends Array<unknown> = [],
  ExcludedTypes extends Array<unknown> = [],
> = {
  [K in keyof T]: T[K] | Remoted<T[K], ProxiedTypes, ExcludedTypes>;
};

/**
 * Recursively transforms a type to make all functions async.
 * Used by Remote and RemoteAutoProxy to transform return values.
 *
 * @typeParam T - The type to transform
 * @typeParam ProxiedTypes - Tuple of types that should be fully proxied
 *   (both methods and properties become async)
 * @typeParam ExcludedTypes - Tuple of types that should NOT be proxied
 *   even if they match ProxiedTypes (takes precedence)
 *
 * - Functions become async: `() => T` → `() => Promise<T>`
 * - Types in ExcludedTypes pass through with only functions transformed
 * - Types in ProxiedTypes become `Proxied<T>` (properties async)
 * - Arrays recurse into elements
 * - Other objects recurse into properties (functions only transformed)
 * - Primitives pass through unchanged
 */
export type Remoted<
  T,
  ProxiedTypes extends Array<unknown> = [],
  ExcludedTypes extends Array<unknown> = [],
> = T extends AnyFunction
  ? (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>
  : T extends ExcludedTypes[number]
    ? {[K in keyof T]: Remoted<T[K], ProxiedTypes, ExcludedTypes>}
    : T extends ProxiedTypes[number]
      ? Proxied<T>
      : T extends Array<infer U>
        ? Array<Remoted<U, ProxiedTypes, ExcludedTypes>>
        : T extends object
          ? {[K in keyof T]: Remoted<T[K], ProxiedTypes, ExcludedTypes>}
          : T;

/**
 * Transforms a class/object type for full proxy access.
 * Both methods AND properties become async (return Promise<T>).
 *
 * Use this when you know you're working with a proxied class instance
 * and need property access to be correctly typed as async.
 *
 * @example
 * ```ts
 * class Counter {
 *   name: string;
 *   count(): number { ... }
 * }
 * // Proxied<Counter> has:
 * //   name: Promise<string>
 * //   count: () => Promise<number>
 * ```
 */
export type Proxied<T> = {
  [K in keyof T]: T[K] extends AnyFunction
    ? (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>>
    : Promise<Awaited<T[K]>>;
};

/**
 * Reserved target ID for the root service.
 */
export const ROOT_TARGET = 0;

/**
 * Message types for the wire protocol.
 */
export type Message =
  | CallMessage
  | ReturnMessage
  | ThrowMessage
  | ReleaseMessage
  | PromiseResolveMessage
  | PromiseRejectMessage;

/**
 * Action type for CallMessage.
 *
 * - 'call': Invoke a method or function with arguments
 * - 'get': Get a property value (method must be property name)
 */
export type CallAction = 'call' | 'get';

/**
 * Call a method on a target object, invoke a function, or get a property.
 *
 * - target: 0 for root service, otherwise a proxy ID
 * - action: 'call' to invoke, 'get' to get property
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
 * Release a proxy, allowing the source to garbage collect the target.
 */
export interface ReleaseMessage {
  type: 'release';
  proxyId: number;
}

/**
 * Resolve a promise that was sent to the remote side.
 */
export interface PromiseResolveMessage {
  type: 'promise-resolve';
  promiseId: number;
  value: WireValue;
}

/**
 * Reject a promise that was sent to the remote side.
 */
export interface PromiseRejectMessage {
  type: 'promise-reject';
  promiseId: number;
  error: SerializedError;
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
   * Enable automatic proxying of nested functions and class instances.
   *
   * When `false` (default): Only top-level arguments and return values are
   * considered for proxying. Nested functions or class instances will fail
   * with a `DataCloneError` from structured clone. Use `debug: true` for
   * better error messages.
   *
   * When `true`: Full payload traversal finds functions and class instances
   * anywhere in the object graph and proxies them automatically.
   *
   * @default false
   */
  autoProxy?: boolean;

  /**
   * Enable debug mode for better error messages.
   *
   * When `true` and `autoProxy` is `false`, performs payload traversal to
   * detect non-cloneable values and throw a helpful `NonCloneableError` with
   * the path to the problematic value (e.g., "options.onChange").
   *
   * Has no effect when `autoProxy` is `true` (traversal happens anyway).
   *
   * @default false
   */
  debug?: boolean;
}

/**
 * Options with autoProxy explicitly set to true.
 * Used for function overloads that return RemoteAutoProxy<T>.
 */
export interface AutoProxyOptions extends Options {
  autoProxy: true;
}

/**
 * Options with autoProxy set to false or omitted (defaults to false).
 * Used for function overloads that return Remote<T>.
 */
export interface ManualOptions extends Options {
  autoProxy?: false;
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
  proxyId: number;
}

export interface WirePromise {
  [WIRE_TYPE]: 'promise';
  promiseId: number;
}

export interface WireProxyProperty {
  [WIRE_TYPE]: 'proxy-property';
  targetProxyId: number;
  property: string;
}

export interface WireThrown {
  [WIRE_TYPE]: 'thrown';
  error: SerializedError;
}

// Type guards for wire values
// Shared helper casts value to record after null/object check
type WireRecord = Record<string, unknown>;
const asWire = (v: unknown): WireRecord | undefined =>
  typeof v === 'object' && v !== null ? (v as WireRecord) : undefined;

export function isWireProxy(value: unknown): value is WireProxy {
  const w = asWire(value);
  return w?.[WIRE_TYPE] === 'proxy' && typeof w['proxyId'] === 'number';
}

export function isWirePromise(value: unknown): value is WirePromise {
  const w = asWire(value);
  return w?.[WIRE_TYPE] === 'promise' && typeof w['promiseId'] === 'number';
}

/**
 * Symbol used to brand proxy properties so they can be detected when passed
 * as arguments. The value contains the target proxy ID and property name.
 */
export const PROXY_PROPERTY_BRAND = Symbol('supertalk.proxyProperty');

/**
 * Metadata stored on proxy properties for detection and serialization.
 */
export interface ProxyPropertyMetadata {
  targetProxyId: number;
  property: string;
}
