/**
 * Wire protocol utilities and runtime helpers.
 *
 * This file contains:
 * - `proxy()` and `handle()` functions for marking values
 * - `getProxyValue()` and `getHandleValue()` for accessing underlying values
 * - Detection helpers (isPromise, isProxyMarker, etc.)
 * - Error serialization/deserialization
 * - NonCloneableError for debug mode
 *
 * Constants live in constants.ts. Type definitions live in types.ts.
 *
 * @fileoverview Runtime utilities for the wire protocol.
 */

import type {
  SerializedError,
  ProxyPropertyMetadata,
  AsyncProxy,
  Handle,
} from './types.js';
import {
  PROXY_VALUE,
  PROXY_PROPERTY_BRAND,
  TRANSFER,
  NON_CLONEABLE,
} from './constants.js';

/**
 * Internal marker to distinguish proxy markers ('proxy') from handle markers ('handle').
 * Not exported - only used internally for wire serialization.
 */
const MARKER_TYPE = Symbol();

/**
 * Symbol for accessing the wrapped value inside a handle's wrapper object.
 */
const HANDLE_VALUE = Symbol();

/**
 * WeakMap to cache handle wrappers for identity preservation on round-trips.
 */
const handleWrappers = new WeakMap<object, object>();

/**
 * Internal interface for proxy markers before they're sent over the wire.
 * Contains the marker type and underlying value.
 */
interface ProxyMarker<T> {
  readonly [PROXY_VALUE]: T;
  readonly [MARKER_TYPE]: 'proxy' | 'handle';
}

// ============================================================
// Proxy marker
// ============================================================

/**
 * Creates an AsyncProxy marker for explicit proxying.
 *
 * Use this to mark values that should be proxied rather than cloned.
 * AsyncProxies provide an async interface for property/method access on both sides.
 *
 * - AsyncProxies do NOT auto-unwrap when sent back — they stay as proxies
 * - Use `getProxyValue(proxy)` to get the underlying value on the owning side
 * - The same `AsyncProxy<T>` type is used on both sides for consistent APIs
 *
 * **When to use `proxy()`:**
 * - **Mutable objects** — The remote side should see updates
 * - **Large graphs** — Avoid cloning expensive data structures
 * - **Class instances with methods** — Preserve the prototype API
 * - **Consistent APIs** — Same function signature in and out of workers
 *
 * **When NOT to use `proxy()`:**
 * - Immutable data (cloning is fine, avoids round-trips)
 * - Small DTOs / config objects
 * - Anything the remote side will just read once
 *
 * @example
 * ```ts
 * class MyService {
 *   createWidget(): AsyncProxy<Widget> {
 *     return proxy(new Widget());
 *   }
 *
 *   updateWidget(widget: AsyncProxy<Widget>): void {
 *     const w = getProxyValue(widget);
 *     w.refresh();
 *   }
 * }
 *
 * // Client (same types locally and remotely)
 * const widget = await service.createWidget();  // AsyncProxy<Widget>
 * await widget.activate();  // Method call is async
 * await service.updateWidget(widget);  // Pass proxy back
 * ```
 */
export function proxy<T extends object>(
  value: T,
  opaque?: boolean,
): AsyncProxy<T> {
  // Opaque proxies are simple marker objects - no JS Proxy overhead
  if (opaque) {
    return {
      [PROXY_VALUE]: value,
      [MARKER_TYPE]: 'handle',
      __nc: NON_CLONEABLE, // Make non-cloneable
    } as unknown as AsyncProxy<T>;
  }
  // JS Proxy provides async interface and is naturally non-cloneable
  return new Proxy(NON_CLONEABLE as T, {
    get(_target, prop) {
      if (prop === PROXY_VALUE) return value;
      if (prop === MARKER_TYPE) return 'proxy';
      // Not thenable at top level (prevents auto-await issues)
      if (prop === 'then') return undefined;
      return createLocalProxyProperty(
        value,
        prop,
        (value as Record<string | symbol, unknown>)[prop],
      );
    },

    set(_target, prop, newValue) {
      (value as Record<string | symbol, unknown>)[prop] = newValue;
      return true;
    },

    apply(_target, _thisArg, args: Array<unknown>) {
      if (typeof value === 'function') {
        return Promise.resolve(
          (value as (...a: Array<unknown>) => unknown)(...args),
        );
      }
      throw new TypeError('Proxy target is not callable');
    },
  }) as unknown as AsyncProxy<T>;
}

/**
 * Create a local proxy property - callable (for methods) and thenable (for property reads).
 * Mirrors the behavior of remote proxy properties but executes synchronously.
 */
function createLocalProxyProperty(
  target: object,
  prop: string | symbol,
  propValue: unknown,
): unknown {
  // Create a callable that invokes the method
  const callable = (...args: Array<unknown>): Promise<unknown> => {
    if (typeof propValue === 'function') {
      return Promise.resolve(propValue.apply(target, args));
    }
    throw new TypeError(`${String(prop)} is not a function`);
  };

  // Make it thenable for property reads: await proxy.prop
  callable.then = <TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> => {
    return Promise.resolve(propValue).then(onfulfilled, onrejected);
  };

  return callable;
}

/**
 * Get the underlying value from an AsyncProxy.
 *
 * This only works on the side that created the proxy. Attempting to
 * dereference a proxy received from the other side will throw, as
 * the value lives on the remote end.
 *
 * @example
 * ```ts
 * const widget = new Widget();
 * const widgetProxy = proxy(widget);
 * const retrieved = getProxyValue(widgetProxy); // Returns the widget
 * ```
 */
export function getProxyValue<T>(proxy: AsyncProxy<T>): T {
  const value = (proxy as unknown as ProxyMarker<T>)[PROXY_VALUE];
  if (value === undefined) {
    throw new TypeError(
      'Cannot get value from a remote proxy. ' +
        'getProxyValue() only works on the side that created the proxy.',
    );
  }
  return value;
}

/**
 * Check if a value is a proxy marker (created with proxy() or handle()).
 */
export function isProxyMarker(value: unknown): value is ProxyMarker<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return (value as ProxyMarker<unknown>)?.[PROXY_VALUE] !== undefined;
}

/**
 * Check if a proxy marker is opaque (created with proxy(v, true) or handle()).
 */
export function isOpaqueMarker(value: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return (value as ProxyMarker<unknown>)?.[MARKER_TYPE] === 'handle';
}

// ============================================================
// Handle marker
// ============================================================

/**
 * Creates a Handle marker for opaque handle passing.
 *
 * Handles are like proxies but completely opaque — they provide NO interface
 * for accessing the underlying value remotely. They're useful when you need
 * consistent APIs but don't need remote property/method access.
 *
 * - Handles do NOT auto-unwrap when sent back — they stay as handles
 * - Use `getHandleValue(handle)` to get the underlying value on the owning side
 * - The same `Handle<T>` type is used on both sides for consistent APIs
 *
 * **When to use `handle()`:**
 * - **Opaque tokens** — Values used as keys or references
 * - **Consistent APIs** — Same function signature in and out of workers
 * - **Security** — Don't expose object internals to remote side
 *
 * **When NOT to use `handle()`:**
 * - If you need to access properties/methods on the remote side (use `proxy()`)
 * - Simple data that can be cloned
 *
 * @example
 * ```ts
 * class MyService {
 *   createSession(id: string): Handle<Session> {
 *     return handle(new Session(id));
 *   }
 *
 *   getSessionName(session: Handle<Session>): string {
 *     const s = getHandleValue(session);
 *     return s.name;
 *   }
 * }
 *
 * // Client (same types locally and remotely)
 * const session = await service.createSession('abc');  // Handle<Session>
 * // session is opaque — can't access properties
 * const name = await service.getSessionName(session);  // Pass handle back
 * ```
 */
export function handle<T extends object>(value: T): Handle<T> {
  // Handles are opaque proxies of a wrapper object. The wrapper provides
  // distinct identity so the same object can be both a handle and proxy.
  let wrapper = handleWrappers.get(value);
  if (wrapper === undefined) {
    wrapper = {[HANDLE_VALUE]: value};
    handleWrappers.set(value, wrapper);
  }
  return proxy(wrapper, true) as unknown as Handle<T>;
}

/**
 * Get the underlying value from a Handle.
 *
 * This only works on the side that created the handle. Attempting to
 * dereference a handle received from the other side will throw, as
 * the value lives on the remote end.
 *
 * @example
 * ```ts
 * const session = new Session();
 * const sessionHandle = handle(session);
 * const retrieved = getHandleValue(sessionHandle); // Returns the session
 * ```
 */
export function getHandleValue<T>(handle: Handle<T>): T {
  // Handle is a proxy of a wrapper, so first get the wrapper via getProxyValue
  const wrapper = getProxyValue(
    handle as unknown as AsyncProxy<{[HANDLE_VALUE]: T}>,
  );
  const value = wrapper[HANDLE_VALUE];
  if (value === undefined) {
    throw new TypeError(
      'Cannot get value from a remote handle. ' +
        'getHandleValue() only works on the side that created the handle.',
    );
  }
  return value;
}

// ============================================================
// Transfer marker
// ============================================================

/**
 * A value marked for transfer when sent across the wire.
 *
 * Transferred values are moved (not copied) — faster for large buffers,
 * but the original becomes unusable (neutered).
 */
export interface TransferMarker<T extends Transferable> {
  readonly [TRANSFER]: true;
  readonly value: T;
}

/**
 * Mark a value for transfer across the wire.
 *
 * Transferred values are moved (not copied) using postMessage's transfer list.
 * This is faster for large data but neuters the original.
 *
 * @example
 * ```ts
 * const service = {
 *   getBuffer(): ArrayBuffer {
 *     const buf = new ArrayBuffer(1024 * 1024);
 *     fillBuffer(buf);
 *     return transfer(buf);  // Move, don't copy
 *   }
 * };
 * ```
 */
export function transfer<T extends Transferable>(value: T): TransferMarker<T> {
  return {[TRANSFER]: true, value};
}

/**
 * Check if a value is a TransferMarker.
 */
export function isTransferMarker(
  value: unknown,
): value is TransferMarker<Transferable> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-boolean-literal-compare
  return (value as TransferMarker<Transferable>)?.[TRANSFER] === true;
}

// ============================================================
// Detection helpers
// ============================================================

/**
 * Check if a value is a proxy property created by Supertalk.
 * These are branded with a symbol containing metadata about the target proxy.
 */
export function isProxyProperty(
  value: unknown,
): value is {[PROXY_PROPERTY_BRAND]: ProxyPropertyMetadata} {
  return (
    typeof (value as {[PROXY_PROPERTY_BRAND]: ProxyPropertyMetadata} | null)?.[
      PROXY_PROPERTY_BRAND
    ] === 'object'
  );
}

/**
 * Check if a value is a Promise (or thenable).
 */
export function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}

/**
 * Serialize an error for transmission.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
    };
    if (error.stack !== undefined) {
      serialized.stack = error.stack;
    }
    return serialized;
  }
  return {
    name: 'Error',
    message: String(error),
  };
}

/**
 * Deserialize an error from transmission.
 */
export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  // @ts-expect-error Stack is writable
  error.stack = serialized.stack;
  return error;
}

/**
 * Error thrown when a non-cloneable value is encountered in debug mode.
 */
export class NonCloneableError extends Error {
  constructor(
    public readonly valueType: 'function' | 'promise' | 'proxy' | 'transfer',
    public readonly path: string,
  ) {
    super(
      `The nested ${valueType} at "${path}" cannot be cloned. Use nestedProxies: true.`,
    );
    this.name = 'NonCloneableError';
  }
}
