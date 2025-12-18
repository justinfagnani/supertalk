/**
 * Expose an object's methods over an endpoint.
 *
 * @packageDocumentation
 */

import type {Endpoint, Message, CallMessage} from './types.js';
import {
  createReturnMessage,
  createThrowMessage,
  serializeError,
} from './protocol.js';

/**
 * Get all method names from an object.
 *
 * For plain objects: own enumerable properties that are functions.
 * For class instances: walk prototype chain up to (not including) Object.prototype.
 */
function getMethods(obj: object): string[] {
  const methods = new Set<string>();

  // Walk the prototype chain
  let current: object | null = obj;
  while (current !== null && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      // Skip constructor and private-looking properties
      if (key === 'constructor' || key.startsWith('_')) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && typeof descriptor.value === 'function') {
        methods.add(key);
      }
    }
    current = Object.getPrototypeOf(current) as object | null;
  }

  return [...methods];
}

/**
 * Check if message is a call message.
 */
function isCallMessage(message: unknown): message is CallMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'call'
  );
}

/**
 * Expose an object's methods to be called from the other side of an endpoint.
 *
 * @param obj - The object whose methods to expose
 * @param endpoint - The endpoint to listen on (Worker, MessagePort, etc.)
 * @returns A cleanup function to stop listening
 */
export function expose(obj: object, endpoint: Endpoint): () => void {
  const methods = getMethods(obj);
  const methodSet = new Set(methods);

  const handleMessage = async (event: MessageEvent<Message>) => {
    const message: unknown = event.data;

    // Only handle call messages
    if (!isCallMessage(message)) {
      return;
    }

    const {id, method, args} = message;

    // Check if method exists
    if (!methodSet.has(method)) {
      endpoint.postMessage(
        createThrowMessage(id, {
          name: 'TypeError',
          message: `Method "${method}" is not exposed`,
        }),
      );
      return;
    }

    // Call the method and handle result
    try {
      // We already verified the method exists via methodSet.has(method)
      const target = obj as Record<string, (...args: unknown[]) => unknown>;
      const fn = target[method];
      if (fn === undefined) {
        throw new Error(`Method "${method}" not found`);
      }
      const result: unknown = await fn.apply(obj, args);
      endpoint.postMessage(createReturnMessage(id, result));
    } catch (error) {
      endpoint.postMessage(createThrowMessage(id, serializeError(error)));
    }
  };

  endpoint.addEventListener('message', handleMessage);

  // Return cleanup function
  return () => {
    endpoint.removeEventListener('message', handleMessage);
  };
}
