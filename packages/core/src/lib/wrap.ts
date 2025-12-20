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
  Options,
} from './types.js';
import {
  createCallMessage,
  createProxyCallMessage,
  createProxyGetMessage,
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
 * A callable function that is also thenable.
 * Enables both `await proxy.method(args)` and `await proxy.property`.
 */
interface CallableThenable {
  (...args: Array<unknown>): Promise<unknown>;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

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
 * @param options - Configuration options
 * @returns A proxy object that forwards method calls
 */
export function wrap<T extends object>(
  endpoint: Endpoint,
  options: Options = {},
): Remote<T> {
  const {autoProxy = false, debug = false} = options;
  let nextCallId = 1;
  const pending = new Map<number, PendingCall>();

  // Registry for local objects we've sent to the remote (callbacks, etc.) - strong refs
  const localObjects = new SourceRegistry();

  // Registry for proxies to remote objects we've received - weak refs with release notification
  const remoteProxies = new ProxyRegistry((proxyId) => {
    // When a remote proxy is garbage collected, notify remote to release
    endpoint.postMessage(createReleaseMessage(proxyId));
  });

  /**
   * Make an RPC call and return a promise for the result.
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
    pending.set(id, {resolve, reject});
    endpoint.postMessage(createProxyCallMessage(id, target, method, wireArgs));
    return promise;
  };

  /**
   * Make a property GET request and return a promise for the result.
   */
  const makeGet = (target: number, property: string): Promise<unknown> => {
    const {promise, resolve, reject} = Promise.withResolvers<unknown>();
    const id = nextCallId++;
    pending.set(id, {resolve, reject});
    endpoint.postMessage(createProxyGetMessage(id, target, property));
    return promise;
  };

  /**
   * Create a "callable thenable" for a property on a remote object.
   *
   * This enables both:
   * - `await proxy.prop` → property GET (one round trip)
   * - `await proxy.method(args)` → method CALL (one round trip)
   *
   * The trick: return a function that also has a `.then()` method.
   * - When called as function: makes a method call
   * - When awaited: makes a property get
   */
  const createCallableThenable = (
    target: number,
    prop: string,
  ): CallableThenable => {
    // The callable part: when invoked as a function, call the method
    const callable = (...args: Array<unknown>): Promise<unknown> => {
      return makeCall(target, prop, args).then(processReturnValue);
    };

    // The thenable part: when awaited, get the property
    callable.then = <TResult1 = unknown, TResult2 = never>(
      onfulfilled?:
        | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): Promise<TResult1 | TResult2> => {
      // Make a GET request for the property value
      return makeGet(target, prop)
        .then(processReturnValue)
        .then(onfulfilled, onrejected);
    };

    return callable;
  };

  /**
   * Process a return value, converting proxy references to actual proxies.
   */
  const processReturnValue = (value: unknown): unknown => {
    return value;
  };

  /**
   * Create a proxy for a remote object (class instance, function, etc.)
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
      // Direct invocation: proxy(args) → call the remote function/object
      apply(_target, _thisArg, args: Array<unknown>) {
        return makeCall(proxyId, undefined, args).then(processReturnValue);
      },

      // Property access: proxy.prop → callable-thenable
      get(_target, prop) {
        if (typeof prop !== 'string') {
          return undefined;
        }
        // Special case: 'then' on the proxy itself for awaiting the whole object
        // This shouldn't normally happen for class instances, but handle it
        if (prop === 'then') {
          return undefined; // Not thenable at the top level
        }
        return createCallableThenable(proxyId, prop);
      },
    });

    remoteProxies.set(proxyId, proxy);
    return proxy;
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
          result = await (proxyTarget as (...a: Array<unknown>) => unknown)(
            ...deserializedArgs,
          );
        } else {
          // Method invocation
          const targetObj = proxyTarget as Record<
            string,
            (...a: Array<unknown>) => unknown
          >;
          const fn = targetObj[method];
          if (typeof fn !== 'function') {
            throw new TypeError(`${method} is not a function`);
          }
          result = await fn.apply(proxyTarget, deserializedArgs);
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
      return (...args: Array<unknown>) => {
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
        pending.set(id, {resolve, reject});
        endpoint.postMessage(createCallMessage(id, prop, wireArgs));
        return promise;
      };
    },
  });

  return proxy;
}
