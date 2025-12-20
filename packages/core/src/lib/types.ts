/**
 * Core type definitions for supertalk.
 *
 * @packageDocumentation
 */

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
  | ReleaseMessage;

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
 * Raw values (primitives, plain objects, arrays) are sent as-is via structured clone.
 * Functions and class instances are replaced with proxy references.
 */
export type WireValue =
  | {type: 'raw'; value: unknown}
  | {type: 'proxy'; proxyId: number}
  | {type: 'thrown'; error: SerializedError};
