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
  postMessage(message: unknown, transfer?: Transferable[]): void;
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
type AnyFunction = (...args: any[]) => any;

export type Remote<T> = {
  [K in keyof T as T[K] extends AnyFunction ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * Message types for the wire protocol.
 */
export type Message = CallMessage | ReturnMessage | ThrowMessage;

export interface CallMessage {
  type: 'call';
  id: number;
  method: string;
  args: unknown[];
}

export interface ReturnMessage {
  type: 'return';
  id: number;
  value: unknown;
}

export interface ThrowMessage {
  type: 'throw';
  id: number;
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
