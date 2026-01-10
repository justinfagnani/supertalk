# Supertalk Implementation Roadmap

## Overview

Implementation proceeds in phases, each building on the previous. Each phase should result in a usable, tested feature set.

---

## Phase 0: Foundation ✅

**Goal**: Project infrastructure

- [x] Monorepo setup with npm workspaces
- [x] Wireit build coordination
- [x] TypeScript configuration (ESNext, strict)
- [x] ESLint + Prettier
- [x] Test infrastructure (node:test, web-test-runner)
- [x] Documentation structure
- [x] AGENTS.md with memory system

---

## Phase 1: Basic RPC ✅

**Goal**: Simple request/response over postMessage

### Deliverables

- [x] `Endpoint` interface definition
- [x] `expose(obj, endpoint)` — Expose an object's methods
- [x] `wrap<T>(endpoint)` — Create typed proxy
- [x] Message protocol for call/return/error
- [x] Basic error serialization
- [x] Works with Worker, MessagePort

### API Shape

```typescript
// Worker
const service = {
  add(a: number, b: number): number {
    return a + b;
  },
};
expose(service, self);

// Main
const worker = new Worker('./worker.js', {type: 'module'});
const proxy = wrap<typeof service>(worker);
const result = await proxy.add(1, 2); // 3
```

### Tests

- [x] Basic method call and return
- [x] Multiple concurrent calls
- [x] Error propagation
- [ ] Worker communication (tested via MessagePort, Worker test pending)
- [x] MessagePort communication

---

## Phase 2: Function Proxying ✅

**Goal**: Pass callbacks that execute on the sender

### Deliverables

- [x] Automatic function detection in arguments
- [x] Proxy creation for functions
- [x] Proxy ID generation and tracking
- [x] Callback invocation protocol
- [x] Memory management with WeakRef/FinalizationRegistry
- [x] Explicit release API (via ReleaseMessage)
- [x] Unified CallMessage with target ID (0 = root service)
- [x] Plain object detection for clone vs pass-through decision

### API Shape

```typescript
// Worker
expose(
  {
    subscribe(callback: (value: number) => void): void {
      setInterval(() => callback(Math.random()), 1000);
    },
  },
  self,
);

// Main
await proxy.subscribe((value) => {
  console.log('Got:', value);
});
```

### Tests

- [x] Callback invocation
- [x] Multiple callbacks
- [x] Callback with return value
- [x] Callback invoked multiple times
- [x] Callbacks nested in objects
- [x] Callbacks nested in arrays
- [x] Functions as return values
- [x] Returned function maintains closure
- [ ] Callback cleanup on GC (needs manual testing)

---

## Phase 3: Class Instance Proxying ✅

**Goal**: Return class instances that become proxies

### Deliverables

- [x] Object reference tracking
- [x] Nested proxy creation
- [x] Property access on proxies (ProxyProperty pattern)
- [x] Sub-service pattern
- [ ] Circular reference handling
- [ ] Callback cleanup on GC (needs manual testing)

### API Shape

```typescript
// Worker
expose(
  {
    getDatabase(): Database {
      return new Database();
    },
  },
  self,
);

// Main
const db = await proxy.getDatabase();
const users = await db.collection('users');
const docs = await users.find({});
```

### Tests

- [x] Return object becomes proxy
- [x] Chained method calls
- [ ] Nested object cleanup
- [ ] Circular reference handling

---

## Phase 3.5: Nested Proxies Mode & Object Graph Handling ✅

**Goal**: Explicit control over proxying behavior

### Design Principle: No Global Configuration

Unlike Comlink which uses a global `transferHandlers` map, Supertalk configures
all behavior per-connection via options to `expose()` and `wrap()`.

### Deliverables

- [x] Opt-in nested proxies mode via options
- [x] Top-level-only proxying in shallow mode (default)
- [x] Diamond-shaped object graph handling in nested proxies mode
- [x] Identity preservation across the connection
- [x] Debug mode with helpful `NonCloneableError` messages

### Nested Proxies Mode (default: off)

```typescript
// With nested proxies (opt-in for full traversal)
const remote = wrap<Service>(endpoint, {nestedProxies: true});
expose(service, endpoint, {nestedProxies: true});

// Without nested proxies (default, simpler mental model)
const remote = wrap<Service>(endpoint); // nestedProxies: false
```

### Shallow Mode (default)

When `nestedProxies: false` (the default), **only top-level values are considered
for proxying** — the direct arguments and return values. Nested values are
cloned via structured clone.

This is simpler and more predictable:

- No payload traversal overhead
- Clear boundary: "what I pass/return might be proxied, nested stuff is copied"
- Functions nested in objects will fail to clone (throws error)

```typescript
// Top-level function arg: proxied
await remote.subscribe((x) => console.log(x)); // ✓ callback proxied

// Nested function in object: ERROR (not auto-proxied)
await remote.configure({
  name: 'test',
  onChange: (x) => console.log(x), // ✗ fails to clone
});
```

### Debug Mode

For better DX when debugging clone errors, enable `debug: true`. This traverses
the payload to produce helpful `NonCloneableError` messages with the path to
the problematic value, without the overhead of actually creating proxies:

```typescript
// Development: get helpful error messages
const remote = wrap<Service>(endpoint, {debug: true});

// Error: NonCloneableError: Value of type 'function' at path 'onChange'
// cannot be cloned. Use proxy() to wrap it, or use nestedProxies: true for functions/promises.
```

If you need nested proxies, enable nested proxies mode.

### Nested Proxies Mode (opt-in)

When `nestedProxies: true`, the full payload is traversed to find functions and
non-plain objects, which are automatically proxied. This enables nested
callbacks and richer data structures.

### Object Graph Identity (nestedProxies only)

```typescript
// Exposed side
const shared = {value: 42};
const service = {
  getData() {
    return {
      a: shared,
      b: shared, // Same object
    };
  },
};

// Wrapped side
const data = await remote.getData();
data.a === data.b; // Should be true!
```

### Tests

- [x] Nested proxies mode opt-in works
- [x] Shallow mode only proxies top-level args/returns
- [x] Nested functions in shallow mode throw on clone
- [x] Debug mode produces NonCloneableError with path
- [x] Diamond object graph → same proxy instance (nestedProxies)
- [x] Deep diamond graphs (nestedProxies)

---

## Phase 4: Promise Support ✅

**Goal**: Full promise support across the boundary in both directions

Promises are class instances, so they need special handling. In nested proxies mode,
promises anywhere in the object graph should be detected and proxied. In debug
mode, we should produce helpful errors since promises may not cause
`DataCloneError` but won't work correctly without `nestedProxies`.

### Deliverables

- [x] Promise detection in arguments and return values
- [x] Bidirectional promise passing (both sides can send promises)
- [x] Promise resolution/rejection protocol
- [x] Nested promises in objects, arrays, class fields (with nestedProxies)
- [x] Debug mode warnings for promises without nestedProxies
- [x] Multiple promises in same payload

### API Shape

```typescript
// Worker sends promise in return value
expose(
  {
    fetchUser(id: string): {profile: Promise<Profile>; posts: Promise<Post[]>} {
      return {
        profile: fetchProfile(id),
        posts: fetchPosts(id),
      };
    },
  },
  self,
  {nestedProxies: true},
);

// Main receives and awaits nested promises
const user = await proxy.fetchUser('123');
const profile = await user.profile; // Resolves remotely
const posts = await user.posts;

// Main sends promise as argument
await proxy.processData(fetchDataLocally()); // Promise proxied, resolved when sender resolves
```

### Tests

- [x] Promise as top-level return value (already works via async)
- [x] Promise in return object property (nestedProxies)
- [x] Promise in return array element (nestedProxies)
- [x] Promise as argument to remote method
- [x] Promise rejection propagates correctly
- [x] Multiple promises in same object
- [x] Deeply nested promises
- [x] Debug mode error for nested promise without nestedProxies

---

## Phase 5: Streams ✅

**Goal**: Transfer ReadableStream/WritableStream

### Deliverables

- [x] Stream detection
- [x] Stream transfer via transferable
- [x] Async iterable support
- [ ] Backpressure handling

### API Shape

```typescript
// Worker
expose(
  {
    readFile(path: string): ReadableStream<Uint8Array> {
      return createReadStream(path);
    },
  },
  self,
);

// Main
const stream = await proxy.readFile('/data.bin');
for await (const chunk of stream) {
  process(chunk);
}
```

### Tests

- [x] Stream transfer
- [x] Async iteration
- [ ] Large data streaming
- [ ] Stream cancellation

---

## Phase 6: Signals Integration ✅

**Goal**: Reactive state across boundaries

**Package**: `@supertalk/signals` (add-on package)

### Deliverables

- [x] Signal detection via handler
- [x] RemoteSignal class with synchronous initial value
- [x] SignalHandler for coordinating both sides
- [x] Change notification protocol via `signal:batch` messages
- [x] Batched updates via queueMicrotask
- [x] Signal.subtle.Watcher integration (with Computed wrapper pattern)

### Implementation Notes

- **Private Computed wrappers for change detection**: `getPending()` returns Computeds that
  are invalidated but not yet read. If we watched user signals directly, reading them
  elsewhere would clear their pending state before our flush. By wrapping each signal in
  a private Computed that only we read, we have a reliable "dirty" flag.
- **Asymmetric handler**: Sender sees `Signal.State`/`Computed`, receiver gets `RemoteSignal`.
  The handler type is cast to accommodate this asymmetry.
- **Synchronous initial value**: When a signal is transferred, its current value is sent
  with the wire representation. `RemoteSignal.get()` returns this immediately.

### API Shape

```typescript
// Worker
const count = new Signal.State(0);
expose(
  {
    get count() {
      return count;
    },
    increment() {
      count.set(count.get() + 1);
    },
  },
  self,
  {handlers: [signalManager.handler]},
);

// Main
const countSignal = await proxy.count;
countSignal.get(); // Synchronously available!
effect(() => console.log(countSignal.get()));
await proxy.increment(); // Effect runs when update arrives
```

### Tests

- [x] Signal transfer with initial value
- [x] Remote updates propagate
- [x] Batched notifications (multiple updates in one message)
- [x] Computed signal transfer
- [x] RemoteSignal works with local Signal.Computed
- [x] Worker-based tests for signal graph isolation

### Future Enhancements

- [ ] Memory management: WeakRef + FinalizationRegistry for automatic signal cleanup
- [ ] Release protocol: Notify sender when receiver no longer needs a signal
- [ ] `@clone()` decorator for synchronous property access (see Phase 7)

---

## Phase 7: Decorators

**Goal**: Declarative service definition with metadata

**Package**: `@supertalk/core` (decorators for core functionality)

### Motivation

Now that we have a concrete use case (`@clone()` for synchronous property access),
decorators have clear value beyond just API sugar.

### The Type Problem

TypeScript decorators don't (yet) affect the type of decorated members. For decorators
that change the remote type (like `@clone()` removing `Promise<>`), we pair the
decorator with a **branded type wrapper**:

```typescript
// Branded type - affects Remote<T> transformation
type Cloned<T> = T & {readonly __cloned: unique symbol};

// Decorator - affects runtime behavior
function clone() {
  /* ... */
}

// Usage - decorator + branded type together
class Service {
  @clone() readonly count: Cloned<Signal.State<number>> = new Signal.State(
    0,
  ) as Cloned<Signal.State<number>>;
}

// Remote<Service>.count is Signal.State<number>, not Promise<Signal.State<number>>
```

This is verbose but explicit and type-safe. When TypeScript adds decorator type
transformation, we can simplify.

### Decorator Categories

#### Field Access Control

| Decorator   | Purpose                         | Type Impact                 |
| ----------- | ------------------------------- | --------------------------- |
| `@clone()`  | Send value once, don't proxy    | Removes `Promise<>` wrapper |
| `@proxy()`  | Force proxy for cloneable value | None (already `Promise<>`)  |
| `@ignore()` | Don't expose property remotely  | Removes property entirely   |
| `@lazy()`   | Don't prefetch, proxy on demand | None (default behavior)     |

#### Method Behavior

| Decorator       | Purpose                     | Type Impact |
| --------------- | --------------------------- | ----------- |
| `@timeout(ms)`  | Timeout for this method     | None        |
| `@retry(n)`     | Retry on failure            | None        |
| `@cached(ttl?)` | Cache result (TTL optional) | None        |
| `@transfer()`   | Mark return as Transferable | None        |

#### Validation/Middleware (Future)

| Decorator           | Purpose                | Type Impact |
| ------------------- | ---------------------- | ----------- |
| `@validate(schema)` | Runtime arg validation | None        |
| `@authorize(role)`  | Check authorization    | None        |
| `@log()`            | Debug logging          | None        |

### Phase 7a: Core Field Decorators

**Deliverables**:

- [ ] `Cloned<T>` branded type
- [ ] `@clone()` decorator + metadata storage
- [ ] `Ignored<T>` branded type
- [ ] `@ignore()` decorator
- [ ] Integration with `expose()` to read metadata
- [ ] `Remote<T>` type updated to handle branded types

### `@clone()` Decorator

Marks a class field as "clone this value" instead of creating a property proxy.
The value is sent once when the service is wrapped, enabling synchronous access.

```typescript
class CounterService {
  // Signal property - cloned once, then updates via signal protocol
  @clone() readonly count: Cloned<Signal.State<number>> = new Signal.State(
    0,
  ) as Cloned<Signal.State<number>>;

  // Regular property - proxied, requires await
  readonly config = {name: 'counter'};

  increment() {
    this.count.set(this.count.get() + 1);
  }
}

// Usage
const remote = wrap<CounterService>(endpoint);
const signal = remote.count; // Synchronous! No await needed
signal.get(); // Works immediately
```

### `@ignore()` Decorator

Marks a field as internal - not exposed remotely at all.

```typescript
class Service {
  @ignore() readonly #internal: Ignored<SomeType> = /* ... */;

  // Or for protected fields that shouldn't leak
  @ignore() readonly _cache: Ignored<Map<string, unknown>> = new Map();
}

// Remote<Service> doesn't include _cache
```

### Design Considerations

1. **Immutability assumption**: `@clone()` implies the property reference won't change.
   If the field is reassigned, the remote won't see the new value.

2. **Branded types are opt-in**: If you don't care about the type, just use the
   decorator without the branded type. Runtime behavior works; types are slightly off.

3. **Metadata storage**: Use standard decorator metadata API or WeakMap fallback.

### Implementation Sketch

```typescript
// Branded types
declare const CLONED: unique symbol;
declare const IGNORED: unique symbol;

export type Cloned<T> = T & { readonly [CLONED]: true };
export type Ignored<T> = T & { readonly [IGNORED]: true };

// Helper to create cloned values
export function cloned<T>(value: T): Cloned<T> {
  return value as Cloned<T>;
}

// Metadata storage
const fieldMetadata = new WeakMap<object, Map<string | symbol, FieldOptions>>();

interface FieldOptions {
  cloned?: boolean;
  ignored?: boolean;
}

// Decorator
function clone(): <T>(
  value: undefined,
  context: ClassFieldDecoratorContext<unknown, T>
) => void {
  return (_value, context) => {
    // Store metadata...
  };
}

// Updated Remote<T> type
type Remote<T> = {
  [K in keyof T as T[K] extends Ignored<unknown> ? never : K]:
    T[K] extends Cloned<infer U> ? Awaited<Remoted<U>>
    : T[K] extends AnyFunction ? /* async wrapper */
    : Promise<Awaited<Remoted<T[K]>>>;
};
```

### Phase 7b: Method Decorators (Future)

```typescript
class Service {
  @timeout(5000)
  @retry(3)
  async fetchData(): Promise<Data> {
    /* ... */
  }

  @cached(60_000) // Cache for 1 minute
  async getConfig(): Promise<Config> {
    /* ... */
  }

  @transfer() // Hint that return value should be transferred
  async getBuffer(): Promise<ArrayBuffer> {
    /* ... */
  }
}
```

### Tests

- [ ] `@clone()` field is synchronously available on remote
- [ ] `Cloned<T>` type removes Promise wrapper in `Remote<T>`
- [ ] `@ignore()` field is not accessible on remote
- [ ] `Ignored<T>` type removes field from `Remote<T>`
- [ ] Non-decorated fields still require await
- [ ] Works with signals (main use case)
- [ ] Decorator without branded type still works at runtime

---

## Phase 8: HTTP Transport

**Goal**: Browser-to-server RPC

### Deliverables

- [ ] HTTP endpoint adapter
- [ ] JSON serialization with superjson support
- [ ] Request/response mapping
- [ ] Server-sent events for push

### API Shape

```typescript
import {httpEndpoint} from '@supertalk/http';

const endpoint = httpEndpoint('https://api.example.com/rpc');
const api = wrap<ApiService>(endpoint);

const result = await api.doSomething();
```

### Tests

- [ ] HTTP call/response
- [ ] Error handling
- [ ] Streaming responses
- [ ] Authentication headers

---

## Phase 9: Advanced Features

**Goal**: Polish and advanced use cases

### Deliverables

- [ ] AbortSignal support for cancellation
- [ ] Call batching
- [ ] Middleware system
- [ ] Custom serializers
- [ ] Performance optimization

---

## Future Considerations

- WebSocket transport
- Node.js worker threads
- SharedArrayBuffer integration
- WebRTC DataChannel transport
- GraphQL-style selective fetching
- Schema generation for documentation

---

## Known Issues / To Investigate

### ArrayBuffer and other built-in types are proxied instead of cloned

**Problem**: `ArrayBuffer`, `TypedArray`, `Date`, `RegExp`, `Map`, `Set`, etc. are
all structured-clone-compatible, but Supertalk proxies them because they're not
"plain objects" (their prototype isn't `Object.prototype`).

**Impact**: Sending an ArrayBuffer creates a proxy and requires an extra round-trip
for each property access, instead of cloning the buffer directly.

**Fix needed**: Add checks in `toWireValue` for structured-clone-compatible built-in
types and pass them through directly instead of proxying.

**Related**: Binary data benchmark is disabled until this is fixed.

---

### ✅ RESOLVED: Benchmark anomaly where nestedProxies appeared faster

**Observed**: In microbenchmarks, `{nestedProxies: true}` connections sometimes showed
10-20% higher ops/sec than non-nestedProxies connections for simple string operations.

**Root cause**: Benchmark harness overhead. When measuring single RPC calls per
iteration, the `performance.now()` calls and loop overhead were significant relative
to the actual work, and JIT/GC effects between iterations dominated the results.

**Fix**: Batch multiple RPC calls per iteration (`CALLS_PER_ITERATION = 10`). This
reduces harness overhead relative to actual work and spreads JIT/GC impact across
more calls, giving stable measurements.

**Results after fix**:

- Simple operations (string, numbers, binary): nested/shallow ratio ≈ 1.0x (identical, as expected)
- Large objects: nested/shallow ratio ≈ 0.59x (nestedProxies slower due to traversal)
- Large arrays: nested/shallow ratio ≈ 0.66x (nestedProxies slower due to traversal)

This matches expectations: nestedProxies has no overhead for primitives, but must
traverse complex structures looking for functions to proxy.

---

## Status Legend

- [ ] Not started
- [~] In progress
- [x] Complete
