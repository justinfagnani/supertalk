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

## Phase 1: Basic RPC

**Goal**: Simple request/response over postMessage

### Deliverables

- [ ] `Endpoint` interface definition
- [ ] `expose(obj, endpoint)` — Expose an object's methods
- [ ] `wrap<T>(endpoint)` — Create typed proxy
- [ ] Message protocol for call/return/error
- [ ] Basic error serialization
- [ ] Works with Worker, MessagePort

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

- [ ] Basic method call and return
- [ ] Multiple concurrent calls
- [ ] Error propagation
- [ ] Worker communication
- [ ] MessagePort communication

---

## Phase 2: Function Proxying

**Goal**: Pass callbacks that execute on the sender

### Deliverables

- [ ] Automatic function detection in arguments
- [ ] Proxy creation for functions
- [ ] Proxy ID generation and tracking
- [ ] Callback invocation protocol
- [ ] Memory management with WeakRef/FinalizationRegistry
- [ ] Explicit release API

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

- [ ] Callback invocation
- [ ] Multiple callbacks
- [ ] Callback cleanup on GC
- [ ] Explicit release
- [ ] Nested callbacks

---

## Phase 3: Nested Objects & Sub-Services

**Goal**: Return objects that become proxies

### Deliverables

- [ ] Object reference tracking
- [ ] Nested proxy creation
- [ ] Property access on proxies
- [ ] Sub-service pattern

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

- [ ] Return object becomes proxy
- [ ] Chained method calls
- [ ] Nested object cleanup
- [ ] Circular reference handling

---

## Phase 4: Decorators

**Goal**: Declarative service definition

### Deliverables

- [ ] `@service()` class decorator
- [ ] `@method()` method decorator
- [ ] Metadata storage system
- [ ] Decorator-based expose

### API Shape

```typescript
@service()
class Calculator {
  @method()
  add(a: number, b: number): number {
    return a + b;
  }
}

expose(new Calculator(), self);
```

### Tests

- [ ] Decorated class exposure
- [ ] Method filtering
- [ ] Decorator options
- [ ] Inheritance handling

---

## Phase 5: Streams

**Goal**: Transfer ReadableStream/WritableStream

### Deliverables

- [ ] Stream detection
- [ ] Stream transfer via transferable
- [ ] Async iterable support
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

- [ ] Stream transfer
- [ ] Async iteration
- [ ] Large data streaming
- [ ] Stream cancellation

---

## Phase 6: Promise-Valued Properties

**Goal**: Objects with promises that resolve remotely

### Deliverables

- [ ] Promise detection in return values
- [ ] Promise resolution protocol
- [ ] Nested promise handling

### API Shape

```typescript
// Worker
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
);

// Main
const user = await proxy.fetchUser('123');
const profile = await user.profile; // Resolves remotely
const posts = await user.posts;
```

### Tests

- [ ] Promise in return object
- [ ] Multiple promises
- [ ] Promise rejection
- [ ] Nested promises

---

## Phase 7: Signals Integration

**Goal**: Reactive state across boundaries

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

## Status Legend

- [ ] Not started
- [~] In progress
- [x] Complete
