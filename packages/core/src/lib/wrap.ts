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
  CallMessage,
  WireValue,
} from './types.js';
import {
  createCallMessage,
  createProxyCallMessage,
  createReleaseMessage,
  createReturnMessage,
  createThrowMessage,
  deserializeError,
  serializeError,
  toWireValue,
  fromWireValue,
} from './protocol.js';
import {SourceRegistry, ProxyRegistry} from './proxy-registry.js';

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
 * Check if message is a call message (for callbacks from remote).
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
 * Create a typed proxy that forwards method calls to a remote endpoint.
 *
 * @param endpoint - The endpoint to send calls to (Worker, MessagePort, etc.)
 * @returns A proxy object that forwards method calls
 */
export function wrap<T extends object>(endpoint: Endpoint): Remote<T> {
  let nextCallId = 1;
  const pending = new Map<number, PendingCall>();

  // Registry for local objects we've sent to the remote (callbacks, etc.) - strong refs
  const localObjects = new SourceRegistry();

  // Registry for proxies to remote objects we've received - weak refs with release notification
  const remoteProxies = new ProxyRegistry((proxyId) => {
    // When a remote proxy is garbage collected, notify remote to release
    endpoint.postMessage(createReleaseMessage(proxyId));
  });

  // Create a proxy function for invoking a remote proxy
  const createRemoteProxy = (proxyId: number): object => {
    const fn = (...args: unknown[]) => {
      const wireArgs = args.map((arg) =>
        toWireValue(arg, (value) => localObjects.register(value)),
      );
      const {promise, resolve, reject} = Promise.withResolvers<unknown>();
      const id = nextCallId++;
      pending.set(id, {resolve, reject});
      endpoint.postMessage(
        createProxyCallMessage(id, proxyId, undefined, wireArgs),
      );
      return promise;
    };
    remoteProxies.set(proxyId, fn);
    return fn;
  };

  // Listen for messages
  const handleMessage = async (event: MessageEvent<Message>) => {
    const message: unknown = event.data;

    if (isReturnMessage(message)) {
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        try {
          const value = fromWireValue(
            message.value,
            (proxyId) => remoteProxies.get(proxyId),
            createRemoteProxy,
          );
          call.resolve(value);
        } catch (error) {
          call.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    } else if (isThrowMessage(message)) {
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        call.reject(deserializeError(message.error));
      }
    } else if (isCallMessage(message)) {
      // Remote is calling a local proxy (callback invocation)
      const {id, target, method, args} = message;

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

      // Deserialize arguments
      const deserializedArgs = args.map((arg: WireValue) =>
        fromWireValue(
          arg,
          (proxyId) => remoteProxies.get(proxyId),
          createRemoteProxy,
        ),
      );

      try {
        let result: unknown;
        if (method === undefined) {
          // Direct function invocation
          if (typeof proxyTarget !== 'function') {
            throw new TypeError('Target is not callable');
          }
          result = await (proxyTarget as (...a: unknown[]) => unknown)(
            ...deserializedArgs,
          );
        } else {
          // Method invocation
          const targetObj = proxyTarget as Record<
            string,
            (...a: unknown[]) => unknown
          >;
          const fn = targetObj[method];
          if (typeof fn !== 'function') {
            throw new TypeError(`${method} is not a function`);
          }
          result = await fn.apply(proxyTarget, deserializedArgs);
        }
        const wireResult = toWireValue(result, (value) =>
          localObjects.register(value),
        );
        endpoint.postMessage(createReturnMessage(id, wireResult));
      } catch (error) {
        endpoint.postMessage(createThrowMessage(id, serializeError(error)));
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
        const wireArgs = args.map((arg) =>
          toWireValue(arg, (value) => localObjects.register(value)),
        );
        const {promise, resolve, reject} = Promise.withResolvers<unknown>();
        const id = nextCallId++;
        pending.set(id, {resolve, reject});
        endpoint.postMessage(createCallMessage(id, prop, wireArgs));
        return promise;
      };
    },
  });

  return proxy;
}
