/**
 * Expose an object's methods over an endpoint.
 *
 * @packageDocumentation
 */

import type {
  Endpoint,
  Message,
  CallMessage,
  ReleaseMessage,
  ReturnMessage,
  ThrowMessage,
} from './types.js';
import {ROOT_TARGET} from './types.js';
import {
  createProxyCallMessage,
  createReturnMessage,
  createThrowMessage,
  deserializeError,
  serializeError,
  toWireValue,
  fromWireValue,
} from './protocol.js';
import {SourceRegistry, ProxyRegistry} from './proxy-registry.js';

/**
 * Pending call waiting for a response (for callback invocations).
 */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Get all method names from an object.
 *
 * For plain objects: own enumerable properties that are functions.
 * For class instances: walk prototype chain up to (not including) Object.prototype.
 */
function getMethods(obj: object): Array<string> {
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
 * Check if message is a release message.
 */
function isReleaseMessage(message: unknown): message is ReleaseMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'release'
  );
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
 * Expose an object's methods to be called from the other side of an endpoint.
 *
 * @param obj - The object whose methods to expose
 * @param endpoint - The endpoint to listen on (Worker, MessagePort, etc.)
 * @returns A cleanup function to stop listening
 */
export function expose(obj: object, endpoint: Endpoint): () => void {
  const methods = getMethods(obj);
  const methodSet = new Set(methods);

  // Registry for objects we're exposing to the remote side (strong refs)
  const localObjects = new SourceRegistry();

  // Registry for proxies to remote objects we've received (weak refs)
  const remoteProxies = new ProxyRegistry();

  // Pending calls for callback invocations (we call remote, wait for response)
  let nextCallId = 1;
  const pendingCalls = new Map<number, PendingCall>();

  // Create a proxy function for a remote proxy ID (e.g., a callback passed from wrap side)
  const createRemoteProxy = (proxyId: number): object => {
    const fn = (...args: Array<unknown>) => {
      // Serialize arguments, which may contain more proxies
      const wireArgs = args.map((arg) =>
        toWireValue(arg, (value) => localObjects.register(value)),
      );
      const {promise, resolve, reject} = Promise.withResolvers<unknown>();
      const id = nextCallId++;
      pendingCalls.set(id, {resolve, reject});
      // Send call message to invoke the callback on the wrap side
      endpoint.postMessage(
        createProxyCallMessage(id, proxyId, undefined, wireArgs),
      );
      return promise;
    };
    remoteProxies.set(proxyId, fn);
    return fn;
  };

  const handleMessage = async (event: MessageEvent<Message>) => {
    const message: unknown = event.data;

    // Handle release messages
    if (isReleaseMessage(message)) {
      localObjects.release(message.proxyId);
      return;
    }

    // Handle return messages (responses to our callback invocations)
    if (isReturnMessage(message)) {
      const call = pendingCalls.get(message.id);
      if (call) {
        pendingCalls.delete(message.id);
        try {
          const value = fromWireValue(
            message.value,
            (pid) => remoteProxies.get(pid),
            createRemoteProxy,
          );
          call.resolve(value);
        } catch (error) {
          call.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      return;
    }

    // Handle throw messages (errors from our callback invocations)
    if (isThrowMessage(message)) {
      const call = pendingCalls.get(message.id);
      if (call) {
        pendingCalls.delete(message.id);
        call.reject(deserializeError(message.error));
      }
      return;
    }

    // Only handle call messages
    if (!isCallMessage(message)) {
      return;
    }

    const {id, target, method, args} = message;

    // Deserialize arguments
    const deserializedArgs = args.map((arg) =>
      fromWireValue(
        arg,
        (proxyId) => remoteProxies.get(proxyId),
        createRemoteProxy,
      ),
    );

    // Handle root service call
    if (target === ROOT_TARGET) {
      // Check if method exists
      if (method === undefined || !methodSet.has(method)) {
        endpoint.postMessage(
          createThrowMessage(id, {
            name: 'TypeError',
            message: `Method "${String(method)}" is not exposed`,
          }),
        );
        return;
      }

      // Call the method and handle result
      try {
        const targetObj = obj as Record<
          string,
          (...args: Array<unknown>) => unknown
        >;
        const fn = targetObj[method];
        if (fn === undefined) {
          throw new Error(`Method "${method}" not found`);
        }
        const result: unknown = await fn.apply(obj, deserializedArgs);
        const wireResult = toWireValue(result, (value) =>
          localObjects.register(value),
        );
        endpoint.postMessage(createReturnMessage(id, wireResult));
      } catch (error) {
        endpoint.postMessage(createThrowMessage(id, serializeError(error)));
      }
      return;
    }

    // Handle proxied target call
    const proxyTarget = localObjects.get(target);
    if (!proxyTarget) {
      endpoint.postMessage(
        createThrowMessage(id, {
          name: 'ReferenceError',
          message: `Proxy target ${String(target)} not found`,
        }),
      );
      return;
    }

    try {
      let result: unknown;

      // Handle property GET
      if (message.action === 'get') {
        if (method === undefined) {
          throw new TypeError('Property name required for get action');
        }
        result = (proxyTarget as Record<string, unknown>)[method];
      } else if (method === undefined) {
        // Direct function invocation
        if (typeof proxyTarget !== 'function') {
          throw new TypeError('Target is not callable');
        }
        result = await (proxyTarget as (...args: Array<unknown>) => unknown)(
          ...deserializedArgs,
        );
      } else {
        // Method invocation on proxied object
        const targetObj = proxyTarget as Record<string, unknown>;
        const value = targetObj[method];
        if (typeof value !== 'function') {
          throw new TypeError(`${method} is not a function`);
        }
        result = await (value as (...args: Array<unknown>) => unknown).apply(
          proxyTarget,
          deserializedArgs,
        );
      }
      const wireResult = toWireValue(result, (value) =>
        localObjects.register(value),
      );
      endpoint.postMessage(createReturnMessage(id, wireResult));
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
