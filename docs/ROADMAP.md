# supertalk Implementation Roadmap

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

## Phase 3.5: Auto-Proxy Mode & Object Graph Handling ✅

**Goal**: Explicit control over proxying behavior

### Design Principle: No Global Configuration

Unlike Comlink which uses a global `transferHandlers` map, supertalk configures
all behavior per-connection via options to `expose()` and `wrap()`.

### Deliverables

- [x] Opt-in auto-proxy mode via options
- [x] Top-level-only proxying in manual mode (default)
- [x] Diamond-shaped object graph handling in auto-proxy mode
- [x] Identity preservation across the connection
- [x] Debug mode with helpful `NonCloneableError` messages

### Auto-Proxy Mode (default: off)

```typescript
// With auto-proxy (opt-in for full traversal)
const remote = wrap<Service>(endpoint, {autoProxy: true});
expose(service, endpoint, {autoProxy: true});

// Without auto-proxy (default, simpler mental model)
const remote = wrap<Service>(endpoint); // autoProxy: false
```

### Manual Proxy Mode (default)

When `autoProxy: false` (the default), **only top-level values are considered
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
// cannot be cloned. Enable autoProxy or use proxy() to wrap this value.
```

If you need nested proxies without full auto-proxy, use auto-proxy mode.

### Auto-Proxy Mode (opt-in)

When `autoProxy: true`, the full payload is traversed to find functions and
non-plain objects, which are automatically proxied. This enables nested
callbacks and richer data structures.

### Object Graph Identity (auto-proxy only)

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

- [x] Auto-proxy mode opt-in works
- [x] Manual mode only proxies top-level args/returns
- [x] Nested functions in manual mode throw on clone
- [x] Debug mode produces NonCloneableError with path
- [x] Diamond object graph → same proxy instance (auto-proxy)
- [x] Deep diamond graphs (auto-proxy)

---

## Phase 4: Promise Support ✅

**Goal**: Full promise support across the boundary in both directions

Promises are class instances, so they need special handling. In auto-proxy mode,
promises anywhere in the object graph should be detected and proxied. In debug
mode, we should produce helpful errors since promises may not cause
`DataCloneError` but won't work correctly without `autoProxy`.

### Deliverables

- [x] Promise detection in arguments and return values
- [x] Bidirectional promise passing (both sides can send promises)
- [x] Promise resolution/rejection protocol
- [x] Nested promises in objects, arrays, class fields (with autoProxy)
- [x] Debug mode warnings for promises without autoProxy
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
  {autoProxy: true},
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
- [x] Promise in return object property (autoProxy)
- [x] Promise in return array element (autoProxy)
- [x] Promise as argument to remote method
- [x] Promise rejection propagates correctly
- [x] Multiple promises in same object
- [x] Deeply nested promises
- [x] Debug mode error for nested promise without autoProxy

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

## Phase 6: Signals Integration (Next)

**Goal**: Reactive state across boundaries

**Package**: `@supertalk/signals` (add-on package)

### Deliverables

- [ ] Signal detection
- [ ] Signal proxy creation
- [ ] Change notification protocol
- [ ] Batched updates
- [ ] Watcher integration

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
);

// Main
const countSignal = await proxy.count;
effect(() => console.log(countSignal.get()));
await proxy.increment(); // Effect runs
```

### Tests

- [ ] Signal transfer
- [ ] Remote updates
- [ ] Batched notifications
- [ ] Signal cleanup

---

## Phase 7: HTTP Transport

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

## Phase 8: Advanced Features

**Goal**: Polish and advanced use cases

### Deliverables

- [ ] AbortSignal support for cancellation
- [ ] Call batching
- [ ] Middleware system
- [ ] Custom serializers
- [ ] Performance optimization

---

## Future Considerations

- **Decorators** — Declarative service definition (`@service()`, `@method()`). Deferred until we have a clearer idea of what value they add.
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
all structured-clone-compatible, but supertalk proxies them because they're not
"plain objects" (their prototype isn't `Object.prototype`).

**Impact**: Sending an ArrayBuffer creates a proxy and requires an extra round-trip
for each property access, instead of cloning the buffer directly.

**Fix needed**: Add checks in `toWireValue` for structured-clone-compatible built-in
types and pass them through directly instead of proxying.

**Related**: Binary data benchmark is disabled until this is fixed.

---

### ✅ RESOLVED: Benchmark anomaly where autoProxy appeared faster

**Observed**: In microbenchmarks, `{autoProxy: true}` connections sometimes showed
10-20% higher ops/sec than non-autoProxy connections for simple string operations.

**Root cause**: Benchmark harness overhead. When measuring single RPC calls per
iteration, the `performance.now()` calls and loop overhead were significant relative
to the actual work, and JIT/GC effects between iterations dominated the results.

**Fix**: Batch multiple RPC calls per iteration (`CALLS_PER_ITERATION = 10`). This
reduces harness overhead relative to actual work and spreads JIT/GC impact across
more calls, giving stable measurements.

**Results after fix**:

- Simple operations (string, numbers, binary): auto/st ratio ≈ 1.0x (identical, as expected)
- Large objects: auto/st ratio ≈ 0.59x (autoProxy slower due to traversal)
- Large arrays: auto/st ratio ≈ 0.66x (autoProxy slower due to traversal)

This matches expectations: autoProxy has no overhead for primitives, but must
traverse complex structures looking for functions to proxy.

---

## Status Legend

- [ ] Not started
- [~] In progress
- [x] Complete
