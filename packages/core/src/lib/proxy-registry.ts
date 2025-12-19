/**
 * Registries for tracking proxied objects and functions.
 *
 * @packageDocumentation
 */

/**
 * Registry for objects we're exposing to a remote endpoint.
 *
 * Holds **strong references** to ensure objects stay alive until the remote
 * explicitly releases them via ReleaseMessage.
 *
 * Used for:
 * - Exposed side: returned functions/objects that wrapped side may invoke
 * - Wrapped side: callbacks passed as arguments that exposed side may invoke
 */
export class SourceRegistry {
  #nextId = 1;
  #idToTarget = new Map<number, object>();
  #targetToId = new WeakMap<object, number>();

  /**
   * Register an object and return its ID.
   * If already registered, returns existing ID.
   */
  register(target: object): number {
    const existingId = this.#targetToId.get(target);
    if (existingId !== undefined) {
      return existingId;
    }

    const id = this.#nextId++;
    this.#idToTarget.set(id, target);
    this.#targetToId.set(target, id);
    return id;
  }

  /**
   * Get the object for an ID.
   */
  get(id: number): object | undefined {
    return this.#idToTarget.get(id);
  }

  /**
   * Check if an object is registered.
   */
  has(target: object): boolean {
    return this.#targetToId.has(target);
  }

  /**
   * Get the ID for an object.
   */
  getId(target: object): number | undefined {
    return this.#targetToId.get(target);
  }

  /**
   * Release an object by ID.
   * Called when remote sends a ReleaseMessage.
   */
  release(id: number): void {
    const target = this.#idToTarget.get(id);
    if (target) {
      this.#targetToId.delete(target);
      this.#idToTarget.delete(id);
    }
  }
}

/**
 * Registry for proxies to remote objects.
 *
 * Holds **weak references** so that when the local proxy is garbage collected,
 * we can notify the remote side to release its object.
 *
 * Used for:
 * - Wrapped side: local proxies for remote functions/objects
 * - Exposed side: local proxies for remote callbacks
 */
export class ProxyRegistry {
  #idToProxy = new Map<number, WeakRef<object>>();
  #proxyToId = new WeakMap<object, number>();
  #cleanup: FinalizationRegistry<number>;

  constructor(onRelease?: (proxyId: number) => void) {
    this.#cleanup = new FinalizationRegistry((proxyId) => {
      this.#idToProxy.delete(proxyId);
      onRelease?.(proxyId);
    });
  }

  /**
   * Store a proxy for a remote ID.
   */
  set(proxyId: number, proxy: object): void {
    this.#idToProxy.set(proxyId, new WeakRef(proxy));
    this.#proxyToId.set(proxy, proxyId);
    this.#cleanup.register(proxy, proxyId);
  }

  /**
   * Get the proxy for a remote ID.
   * Returns undefined if not found or garbage collected.
   */
  get(proxyId: number): object | undefined {
    const ref = this.#idToProxy.get(proxyId);
    return ref?.deref();
  }

  /**
   * Check if we have a proxy for this ID.
   */
  has(proxyId: number): boolean {
    const ref = this.#idToProxy.get(proxyId);
    return ref?.deref() !== undefined;
  }

  /**
   * Get the ID for a proxy object.
   */
  getId(proxy: object): number | undefined {
    return this.#proxyToId.get(proxy);
  }
}
