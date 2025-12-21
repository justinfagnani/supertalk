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

/**
 * Converts a type T to its "remote" version where all methods return Promises.
 *
 * - Methods become async (return Promise<Awaited<ReturnType>>)
 * - Non-function properties are excluded for now (Phase 1)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: Array<any>) => any;

export type Remote<T> = {
  [K in keyof T as T[K] extends AnyFunction ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
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
