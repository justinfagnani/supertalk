# Add-on Packages Brainstorm

> **Status**: Planning — Ideas for future `@supertalk/*` packages

This document catalogs potential add-on packages for Supertalk. The core library (`@supertalk/core`) is intentionally minimal; additional functionality can be added via separate packages that provide handlers, transports, or framework integrations.

## Design Principles

1. **Zero cost if not used** — Core stays small; import only what you need
2. **Handler-based** — Most packages provide handlers that plug into `expose()`/`wrap()`
3. **Tree-shakeable** — Each package should be independently importable
4. **Type-safe** — Handlers should influence types where possible

---

## Handler Packages

These packages extend serialization/deserialization capabilities.

### `@supertalk/collections`

Handlers for `Map`, `Set`, `WeakMap`, `WeakSet` with configurable behavior:

- **Clone mode**: Convert to/from arrays on the wire (data copied)
- **Proxy mode**: Keep mutable reference across boundary (changes sync)

```typescript
import {mapHandler, setHandler} from '@supertalk/collections';

expose(service, port, {
  handlers: [mapHandler({mode: 'clone'}), setHandler({mode: 'proxy'})],
});
```

### `@supertalk/observables`

Handler for RxJS `Observable`/`Subject` or TC39 Observable proposal:

- Subscribe to observables across boundaries
- Automatic cleanup on unsubscribe or disconnect
- Backpressure support

Enables pub-sub patterns that are frequently requested (Comlink #648).

### `@supertalk/classes`

Serializable class registration — instances are serialized to data + class ID, reinstantiated on the receiving side:

```typescript
import {registerClass, classHandler} from '@supertalk/classes';

@registerClass('user')
class User {
  constructor(
    public id: string,
    public name: string,
  ) {}
}

// On receive: new User(wire.id, wire.name)
```

Could support sync modes where changes to the instance propagate back.

### `@supertalk/errors`

Rich error serialization preserving:

- Stack traces
- Custom error subclasses
- `cause` chains
- Custom properties

Addresses Comlink #679 where error information is lost across boundaries.

### `@supertalk/superjson`

Pluggable serializer using [superjson](https://github.com/blitz-js/superjson) for HTTP transports:

- `Date`, `RegExp`, `Map`, `Set`, `BigInt`, `undefined`
- Circular reference handling
- Custom type registration

### `@supertalk/devalue`

Alternative serializer using [devalue](https://github.com/Rich-Harris/devalue):

- Circular references
- More compact output
- Similar type coverage to superjson

---

## Transport & Runtime Packages

### `@supertalk/worker-pool`

Worker pool with load balancing — the #1 feature request pattern in Comlink (#657):

```typescript
import {createPool} from '@supertalk/worker-pool';

const pool = createPool(() => new Worker('./worker.js'), {
  size: navigator.hardwareConcurrency,
  strategy: 'round-robin' | 'least-busy' | 'random',
});

const result = await pool.run((worker) => worker.expensiveTask(data));
```

Features:

- Automatic worker lifecycle management
- Task queuing when all workers busy
- Worker health monitoring and restart
- Graceful shutdown

### `@supertalk/broadcast-channel`

Adapter for `BroadcastChannel` API — pub-sub across tabs/windows/workers:

```typescript
import {broadcastChannel} from '@supertalk/broadcast-channel';

const channel = broadcastChannel('my-app');
channel.subscribe('event-name', (data) => console.log(data));
channel.publish('event-name', {foo: 'bar'});
```

### `@supertalk/shared-worker`

Utilities for SharedWorker connections:

- Client enumeration and management
- Connection lifecycle hooks
- Automatic cleanup when tabs close

Addresses issues like Comlink #673 (finalizer issues with SharedWorkers).

### `@supertalk/service-worker`

Service Worker adapter with suspend/resume handling:

- Detect SW suspension and queue messages
- Automatic reconnection after SW restarts
- Wake-up patterns

Addresses Comlink #637 where SW suspension breaks communication.

### `@supertalk/electron`

Electron IPC adapter:

- `ipcMain` / `ipcRenderer` bridge
- `contextBridge` integration
- Preload script utilities

### `@supertalk/react-native`

React Native WebView bridge:

- `postMessage` wrapper for WebView communication
- Native module bridge patterns

### `@supertalk/http`

HTTP transport for browser-to-server RPC:

- Fetch-based with streaming support
- Request batching
- Future: WebTransport when available

### `@supertalk/websocket`

WebSocket transport:

- Automatic reconnection with backoff
- Heartbeat/keepalive
- Message queuing during disconnect

---

## Event & Subscription Packages

### `@supertalk/events`

DOM-style `EventTarget`/`EventEmitter` across boundaries:

```typescript
// Worker side
class Service extends EventTarget {
  startProcess() {
    this.dispatchEvent(new CustomEvent('progress', {detail: 0.5}));
  }
}

// Main thread
const service = wrap<Service>(worker);
service.addEventListener('progress', (e) => console.log(e.detail));
```

### `@supertalk/pubsub`

Lightweight topic-based pub-sub:

```typescript
import {createPubSub} from '@supertalk/pubsub';

const pubsub = createPubSub(port);
pubsub.subscribe('user:login', (user) => console.log(user));
pubsub.publish('user:login', {id: '123', name: 'Alice'});
```

### `@supertalk/async-iterator`

Enhanced async iterator support:

- Backpressure handling
- Cancellation via AbortSignal
- Buffering strategies
- `for await` across boundaries

---

## Developer Experience Packages

### `@supertalk/devtools`

Browser DevTools extension:

- Inspect active connections
- View proxied objects and their references
- Message log with timing
- Memory/leak detection

### `@supertalk/debug`

Debug utilities for development:

```typescript
import {debugHandler} from '@supertalk/debug';

expose(service, port, {
  handlers: [debugHandler({logMessages: true, measureLatency: true})],
});
```

### `@supertalk/testing`

Test utilities:

- Mock transports (synchronous message passing)
- Connection simulators (latency, failures)
- Snapshot testing for wire formats

```typescript
import {createMockPorts} from '@supertalk/testing';

const [port1, port2] = createMockPorts({sync: true});
// Messages pass synchronously for easier testing
```

---

## Framework Integration Packages

### `@supertalk/react`

React hooks and utilities:

```typescript
import { useWorker, useRemote, useSignal } from '@supertalk/react';

function Component() {
  const worker = useWorker(() => new Worker('./worker.js'));
  const service = useRemote(worker);
  const count = useSignal(service.counter); // if using signals

  return <button onClick={() => service.increment()}>Count: {count}</button>;
}
```

### `@supertalk/vue`

Vue composables:

```typescript
import {useWorker, useRemote} from '@supertalk/vue';

const worker = useWorker(() => new Worker('./worker.js'));
const service = useRemote(worker);
```

### `@supertalk/solid`

Solid.js integration with native signal interop.

---

## Priority Assessment

### High Priority (commonly requested)

| Package                  | Rationale                                     |
| ------------------------ | --------------------------------------------- |
| `@supertalk/collections` | Map/Set handling is a constant pain point     |
| `@supertalk/worker-pool` | #1 feature request pattern in Comlink         |
| `@supertalk/observables` | Pub-sub/push patterns are hugely requested    |
| `@supertalk/errors`      | Better error handling is almost always needed |

### Medium Priority (valuable additions)

| Package                        | Rationale                                      |
| ------------------------------ | ---------------------------------------------- |
| `@supertalk/classes`           | Unique capability, powerful for domain objects |
| `@supertalk/superjson`         | Essential for HTTP transports                  |
| `@supertalk/broadcast-channel` | Multi-tab coordination increasingly common     |
| `@supertalk/testing`           | Enables better library adoption                |

### Lower Priority (niche but valuable)

| Package                   | Rationale                              |
| ------------------------- | -------------------------------------- |
| Framework integrations    | Can be community-contributed           |
| `@supertalk/electron`     | Niche but high-value for that audience |
| `@supertalk/react-native` | Same as above                          |
| `@supertalk/devtools`     | Nice to have, high effort              |

---

## Related Resources

- [Comlink Issues](https://github.com/GoogleChromeLabs/comlink/issues) — Feature requests and pain points
- [Transporter](https://github.com/daniel-nagy/transporter) — Similar library with Observable-based pub-sub
- [superjson](https://github.com/blitz-js/superjson) — JSON serializer with extended type support
