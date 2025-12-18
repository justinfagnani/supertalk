# supertalk Goals

## Vision

supertalk is a unified, type-safe communication library for all kinds of out-of-process communication in JavaScript/TypeScript applications:

- **Web Workers** — Main thread ↔ Worker
- **Iframes** — Parent ↔ Child frames (same-origin and cross-origin)
- **Node Worker Threads** — Main thread ↔ Worker threads
- **Browser ↔ Server RPC** — HTTP, WebSocket, and other transports

The library aims to replace [Comlink](https://github.com/GoogleChromeLabs/comlink/) and potentially [tRPC](https://trpc.io/) with a single, composable, and type-safe solution.

---

## Core Goals

### 1. Type Safety

- **Clients get typed interfaces** — Full autocomplete and type checking for remote calls
- **Servers get serialization guidance** — Type errors when returning non-serializable data
- **No runtime surprises** — Types accurately reflect what can be sent/received

### 2. Simple DX for Simple Cases

- Basic request/response should require minimal boilerplate
- "Hello World" should be 5-10 lines of code
- Progressive complexity — start simple, add features as needed

### 3. Decoupled Type Definitions

- Define service interfaces separately from implementations
- Clients should NOT be required to import from server code
- Support multiple patterns:
  - **Shared interface package** (recommended for large projects)
  - **Type-only import** of service class (convenient for smaller projects)
  - **Runtime-only** (no compile-time types, for dynamic scenarios)

### 4. Declarative Service Definitions

- Prefer decorated classes over builder patterns
- Metadata via standard decorators (Stage 3), not proprietary DSLs
- Minimal boilerplate for common cases

```typescript
// Goal: Something like this
@service()
class Calculator {
  @method()
  add(a: number, b: number): number {
    return a + b;
  }
}
```

### 5. Rich Serialization

| Transport      | Serialization    | Features                                       |
| -------------- | ---------------- | ---------------------------------------------- |
| postMessage    | Structured clone | Transferables (ArrayBuffer, MessagePort, etc.) |
| HTTP/WebSocket | JSON             | Pluggable serializers (superjson, etc.)        |

- Use the richest serialization available for each transport
- Automatic fallback to simpler serialization when needed
- Custom serialization hooks for user-defined types

### 6. Async-First Design

All communication is inherently async. Support:

- **Promises** — Basic async return values
- **Promise-valued properties** — `{ data: Promise<T> }` resolves remotely
- **Streams** — `ReadableStream`, `WritableStream`
- **Async iterables** — `async function* generator()`
- **Multiple in-flight calls** — Concurrent requests without blocking

### 7. Transparent Proxying

Easy proxying for values that can't or shouldn't be cloned:

- **Functions/callbacks** — Pass callbacks that execute on the sender
- **Expensive objects** — Reference large objects without cloning
- **Graph nodes** — Reference nodes in a large graph structure
- **Sub-services** — Return service instances from methods

### 8. Signals Integration

Support TC39 Signals proposal for reactive state:

- Send a Signal, receive a Signal
- Automatic change propagation across boundaries
- Batched updates for efficiency
- Framework-agnostic (works with any Signals implementation)

### 9. Memory Safety

Prevent memory leaks from proxied objects:

- **WeakRef** for proxy references on receiver side
- **FinalizationRegistry** for cleanup notifications
- **Explicit release** option for deterministic cleanup
- **`using` declarations** for scoped proxy lifetime

### 10. Composability

No special cases — nested objects work like top-level:

- Return sub-services from methods
- Pass complex object graphs with embedded proxies
- Compose services from other services
- Same behavior at any nesting level

---

## Non-Goals

Things we explicitly are NOT trying to do:

1. **Support legacy browsers** — Chrome-only initially, modern evergreen later
2. **Support CommonJS** — ESM-only
3. **Replace all RPC frameworks** — Focus on worker/iframe/thread use cases first
4. **Zero dependencies** — We'll use dependencies where they add value
5. **Framework integration** — Core library is framework-agnostic; integrations are separate packages

---

## Comparison with Alternatives

### vs Comlink

| Feature           | Comlink            | supertalk                      |
| ----------------- | ------------------ | ------------------------------ |
| Basic RPC         | ✅                 | ✅                             |
| Type safety       | Partial            | Full                           |
| Nested proxies    | ❌                 | ✅                             |
| Function proxying | Manual (`proxy()`) | Automatic                      |
| Streams           | ❌                 | ✅                             |
| Signals           | ❌                 | ✅                             |
| HTTP transport    | ❌                 | ✅                             |
| Memory management | Basic              | WeakRef + FinalizationRegistry |

### vs tRPC

| Feature         | tRPC            | supertalk  |
| --------------- | --------------- | ---------- |
| Type safety     | ✅              | ✅         |
| No type imports | ❌              | ✅         |
| Worker support  | ❌              | ✅         |
| Declarative     | Builder pattern | Decorators |
| Streaming       | ✅              | ✅         |
| Validation      | Built-in (Zod)  | Pluggable  |

---

## Success Criteria

We'll know supertalk is successful when:

1. **5-line Hello World** — Simplest case is truly simple
2. **Zero type imports from server** — Clients work without importing server code
3. **Comlink migration path** — Easy to migrate existing Comlink code
4. **Composable by default** — Nested objects just work
5. **Memory-safe proxies** — No leaks in long-running applications
6. **Rich async support** — Streams and iterables work seamlessly
