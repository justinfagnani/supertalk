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
  Options,
} from './types.js';
import {ROOT_TARGET} from './types.js';
import {
  createProxyCallMessage,
  createProxyGetMessage,
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
 * @param options - Configuration options
 * @returns A cleanup function to stop listening
 */
export function expose(
  obj: object,
  endpoint: Endpoint,
  options: Options = {},
): () => void {
  const {autoProxy = false, debug = false} = options;
  const methods = getMethods(obj);
  const methodSet = new Set(methods);

  // Registry for objects we're exposing to the remote side (strong refs)
  const localObjects = new SourceRegistry();

  // Registry for proxies to remote objects we've received (weak refs)
  const remoteProxies = new ProxyRegistry();

  // Pending calls for callback invocations (we call remote, wait for response)
  let nextCallId = 1;
  const pendingCalls = new Map<number, PendingCall>();

  /**
   * Make an RPC call to the remote side and return a promise for the result.
   */
  const makeCall = (
    target: number,
    method: string | undefined,
    args: Array<unknown>,
  ): Promise<unknown> => {
    const wireArgs = args.map((arg) =>
      toWireValue(
        arg,
        (value) => localObjects.register(value),
        autoProxy,
        debug,
      ),
    );
    const {promise, resolve, reject} = Promise.withResolvers<unknown>();
    const id = nextCallId++;
    pendingCalls.set(id, {resolve, reject});
    endpoint.postMessage(createProxyCallMessage(id, target, method, wireArgs));
    return promise;
  };

  /**
   * Make a property GET request to the remote side.
   */
  const makeGet = (target: number, property: string): Promise<unknown> => {
    const {promise, resolve, reject} = Promise.withResolvers<unknown>();
    const id = nextCallId++;
    pendingCalls.set(id, {resolve, reject});
    endpoint.postMessage(createProxyGetMessage(id, target, property));
    return promise;
  };

  /**
   * Create a "callable thenable" for a property on a remote proxy.
   *
   * This enables both:
   * - `await proxy.method(args)` → method CALL
   * - `await proxy.prop` → property GET
   */
  const createCallableThenable = (
    target: number,
    prop: string,
  ): ((...args: Array<unknown>) => Promise<unknown>) & {
    then: <T1, T2>(
      onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ) => Promise<T1 | T2>;
  } => {
    const callable = (...args: Array<unknown>): Promise<unknown> => {
      return makeCall(target, prop, args);
    };

    callable.then = <T1 = unknown, T2 = never>(
      onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): Promise<T1 | T2> => {
      return makeGet(target, prop).then(onfulfilled, onrejected);
    };

    return callable;
  };

  /**
   * Create a proxy for a remote object (passed from wrap side).
   *
   * For functions: the proxy is directly callable
   * For objects: property access returns callable-thenables
   */
  const createRemoteProxy = (proxyId: number): object => {
    // Check if we already have a proxy for this ID
    const existing = remoteProxies.get(proxyId);
    if (existing) {
      return existing;
    }

    // Create a function that can be called directly (for function proxies)
    // but also acts as an object with property access (for class instances)
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const proxyTarget = function () {} as unknown as object;

    const proxy = new Proxy(proxyTarget, {
      // Direct invocation: proxy(args) → call the remote function
      apply(_target, _thisArg, args: Array<unknown>) {
        return makeCall(proxyId, undefined, args);
      },

      // Property access: proxy.prop → callable-thenable
      get(_target, prop) {
        if (typeof prop !== 'string') {
          return undefined;
        }
        // 'then' at top level means this is not thenable itself
        if (prop === 'then') {
          return undefined;
        }
        return createCallableThenable(proxyId, prop);
      },
    });

    remoteProxies.set(proxyId, proxy);
    return proxy;
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
        const wireResult = toWireValue(
          result,
          (value) => localObjects.register(value),
          autoProxy,
          debug,
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
      const wireResult = toWireValue(
        result,
        (value) => localObjects.register(value),
        autoProxy,
        debug,
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
