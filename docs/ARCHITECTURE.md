# supertalk Architecture

> **Status**: Draft — To be expanded as design solidifies

## Overview

supertalk is structured in layers:

```
┌─────────────────────────────────────────────────────────┐
│                      User API                           │
│         expose(), wrap(), @service, @method             │
├─────────────────────────────────────────────────────────┤
│                    Proxy System                         │
│        Creates transparent proxies for remote access    │
├─────────────────────────────────────────────────────────┤
│                  Message Protocol                       │
│       Request/response, streaming, proxy lifecycle      │
├─────────────────────────────────────────────────────────┤
│                 Serialization Layer                     │
│    Structured clone, JSON, custom serializers           │
├─────────────────────────────────────────────────────────┤
│                   Transport Layer                       │
│   postMessage, MessagePort, HTTP, WebSocket             │
└─────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### Endpoint

An `Endpoint` is an abstraction over any bidirectional communication channel:

```typescript
interface Endpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
}
```

Implementations:

- `Worker` / `DedicatedWorkerGlobalScope`
- `MessagePort`
- `Window` (for iframes)
- `BroadcastChannel`
- HTTP adapter (request/response as messages)

### Service

A service is a class or object whose methods can be called remotely:

```typescript
@service()
class MyService {
  @method()
  async doSomething(arg: string): Promise<Result> {
    // ...
  }
}
```

### Remote

A `Remote<T>` is a proxy type that represents a remote service:

```typescript
type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
```

---

## Message Protocol

> **TODO**: Define message format

Messages between endpoints:

```typescript
type Message =
  | CallMessage // Method invocation
  | ReturnMessage // Successful return
  | ErrorMessage // Error return
  | ProxyMessage // Create/release proxy
  | StreamMessage // Stream chunk/end
  | SignalMessage; // Signal update
```

### Message IDs

Each request has a unique ID for correlating responses:

```typescript
interface CallMessage {
  type: 'call';
  id: string;
  path: PropertyKey[];
  args: unknown[];
}

interface ReturnMessage {
  type: 'return';
  id: string;
  value: unknown;
}
```

---

## Proxy System

### Creating Proxies

When `wrap()` is called, we create a Proxy that:

1. Intercepts property access → builds path
2. Intercepts function calls → sends CallMessage
3. Returns Promises that resolve when ReturnMessage arrives

### Proxy Lifecycle

```
┌──────────────┐         ┌──────────────┐
│   Sender     │         │   Receiver   │
├──────────────┤         ├──────────────┤
│              │ create  │              │
│  Real Object ├────────►│    Proxy     │
│              │         │  (WeakRef)   │
│              │         │              │
│              │ release │              │
│  (released)  │◄────────┤  (GC'd)      │
└──────────────┘         └──────────────┘
```

- Sender retains real object until release
- Receiver holds WeakRef to proxy
- FinalizationRegistry notifies sender when proxy is GC'd

---

## Serialization

### Structured Clone (postMessage)

For worker/iframe communication, use browser's structured clone:

- Automatically handles: primitives, arrays, objects, Map, Set, Date, RegExp, ArrayBuffer, etc.
- Transferables: ArrayBuffer, MessagePort, ReadableStream, etc.
- NOT supported: functions, Proxies, DOM nodes

### JSON (HTTP)

For HTTP transport:

- Default: `JSON.stringify` / `JSON.parse`
- Enhanced: pluggable serializers (superjson for Date, Map, Set, etc.)

### Custom Serialization

For types that need special handling:

```typescript
interface Serializable<T, S> {
  [serializeSymbol](value: T): S;
  [deserializeSymbol](serialized: S): T;
}
```

---

## Transport Layer

### postMessage Transport

```typescript
class PostMessageTransport implements Transport {
  constructor(endpoint: Endpoint) {}

  send(message: Message, transfer?: Transferable[]): void;
  onMessage(handler: (message: Message) => void): void;
}
```

### HTTP Transport

> **TODO**: Design HTTP transport

Considerations:

- Request/response mapping to call/return messages
- Long-polling or SSE for server-initiated messages
- WebSocket option for bidirectional

---

## Open Questions

1. **Decorator metadata**: How much runtime metadata do we need? Can we infer from types alone?

2. **Proxy granularity**: When should nested objects become separate proxies vs. cloned?

3. **Stream backpressure**: How do we handle backpressure across the boundary?

4. **Error serialization**: How do we serialize Error objects with stack traces?

5. **Cancellation**: How does AbortSignal work across the boundary?

6. **Batching**: When/how do we batch multiple calls?

---

## Implementation Phases

See [ROADMAP.md](ROADMAP.md) for detailed implementation plan.
