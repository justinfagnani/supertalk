/**
 * Create a typed proxy for a remote object.
 *
 * @packageDocumentation
 */

import type {
  Endpoint,
  Message,
  Remote,
  ReturnMessage,
  ThrowMessage,
} from './types.js';
import {createCallMessage, deserializeError} from './protocol.js';

/**
 * Pending call waiting for a response.
 */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Check if message is a return message.
 */
function isReturnMessage(message: unknown): message is ReturnMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'return'
  );
}

/**
 * Check if message is a throw message.
 */
function isThrowMessage(message: unknown): message is ThrowMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'throw'
  );
}

/**
 * Create a typed proxy that forwards method calls to a remote endpoint.
 *
 * @param endpoint - The endpoint to send calls to (Worker, MessagePort, etc.)
 * @returns A proxy object that forwards method calls
 */
export function wrap<T extends object>(endpoint: Endpoint): Remote<T> {
  let nextId = 1;
  const pending = new Map<number, PendingCall>();

  // Listen for responses
  const handleMessage = (event: MessageEvent<Message>) => {
    const message: unknown = event.data;

    if (isReturnMessage(message)) {
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        call.resolve(message.value);
      }
    } else if (isThrowMessage(message)) {
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        call.reject(deserializeError(message.error));
      }
    }
  };

  endpoint.addEventListener('message', handleMessage);

  // Create a proxy that intercepts method calls
  const proxy = new Proxy({} as Remote<T>, {
    get(_target, prop) {
      // Only handle string properties (method names)
      if (typeof prop !== 'string') {
        return undefined;
      }

      // Return a function that sends a call message
      return (...args: unknown[]) => {
        const {promise, resolve, reject} = Promise.withResolvers<unknown>();
        const id = nextId++;
        pending.set(id, {resolve, reject});
        endpoint.postMessage(createCallMessage(id, prop, args));
        return promise;
      };
    },
  });

  return proxy;
}
