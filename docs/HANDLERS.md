# Pluggable Handlers Design

> **Status**: Implemented — See [handlers/streams.ts](../packages/core/src/lib/handlers/streams.ts) for built-in examples

## Overview

Handlers provide a pluggable way to customize how values are serialized and deserialized across the wire. This enables support for:

- **Collections**: Maps, Sets that stay mutable via proxying
- **Streams**: ReadableStream/WritableStream transferred across boundary
- **Signals**: TC39 Signals for reactive state sync
- **Custom types**: User-defined serialization for domain objects

## Design Goals

1. **Zero cost when not used** — No traversal overhead if no handlers registered
2. **Minimal overhead when used** — Fast matching, early exit
3. **Composable** — Handlers work with existing shallow/nested modes
4. **Type-safe** — Handlers can influence return types where possible

## Handler Interface

```typescript
interface Handler<T = unknown, W extends object = object> {
  /**
   * Unique wire type identifier for this handler.
   * Used to route deserialization and handler messages.
   * Convention: 'signal', 'stream', '<package>:<name>', 'app:<name>'
   */
  wireType: string;

  /**
   * Fast check if this handler applies to a value.
   * Called during serialization traversal.
   * Return true to handle this value, false to skip.
   */
  canHandle(value: unknown): value is T;

  /**
   * Serialize the value for wire transmission.
   *
   * Use context methods to build safe, well-formed wire values:
   * - ctx.toWire(proxy(value)) — proxy the value
   * - ctx.toWire(value, key) — recursively process nested values
   * - ctx.toWire(transfer(value)) — add to transfer list
   *
   * Return either:
   * - A wire value from a context method (proxy, promise)
   * - A custom wire object with [WIRE_TYPE] set to this handler's wireType
   */
  toWire(value: T, ctx: ToWireContext): WireValue;

  /**
   * Deserialize a value from wire format.
   * Only called for custom wire objects (not proxy/promise results).
   * The wire object is the custom data you returned from toWire().
   */
  fromWire?(wire: W, ctx: FromWireContext): T;

  // --- Lifecycle methods (optional, for subscription-oriented handlers) ---

  /**
   * Called when the handler is attached to a connection.
   * Use this to store the context for sending messages later.
   */
  connect?(ctx: HandlerConnectionContext): void;

  /**
   * Called when a message arrives for this handler's wireType.
   * The payload has already been deserialized through fromWire.
   */
  onMessage?(payload: unknown): void;

  /**
   * Called when the connection closes.
   * Use this to clean up resources (unwatching signals, closing streams, etc.).
   */
  disconnect?(): void;
}
```

### ToWireContext

Handlers use context methods to create well-formed wire values. Handlers never
deal with IDs directly — the context handles all registration and bookkeeping.

```typescript
interface ToWireContext {
  /**
   * Recursively process a nested value.
   * Applies handlers and default behavior, returns wire-safe value.
   * @param key Optional key for error path building (e.g., 'name', '0')
   */
  toWire(value: unknown, key?: string): WireValue;
}
```

### FromWireContext

```typescript
interface FromWireContext {
  /**
   * Recursively process a nested wire value.
   * Handles proxies, promises, and nested handler values.
   */
  fromWire(wire: WireValue): unknown;
}
```

### HandlerConnectionContext

For handlers that need to send messages outside of RPC calls:

```typescript
interface HandlerConnectionContext {
  /**
   * Send a message to the remote handler with the same wireType.
   * The payload is serialized through toWire before sending.
   */
  sendMessage(payload: unknown): void;
}
```

## Transferables

### The `transfer()` Marker

For user code that wants to transfer values without writing a handler:

```typescript
import {transfer} from '@supertalk/core';

const service = {
  // Transfer the buffer (move, not copy) — faster, original neutered
  getBuffer(): ArrayBuffer {
    const buf = new ArrayBuffer(1024 * 1024);
    fillBuffer(buf);
    return transfer(buf);
  },

  // Without transfer(), ArrayBuffer is cloned (slower, original stays valid)
  getBufferCopy(): ArrayBuffer {
    return new ArrayBuffer(1024);
  },
};
```

### Transferred Values Preserve Type

Transferables are special — `postMessage` handles their serialization automatically.
A transferred `ReadableStream` arrives as a `ReadableStream`. Handlers for
transferables just need to use `transfer()` — no `fromWire` is needed.

```typescript
// Simple stream handler — transfer handles serialization
const readableStreamHandler: Handler<ReadableStream> = {
  wireType: 'transfer:readable-stream',
  canHandle: (v): v is ReadableStream => v instanceof ReadableStream,
  toWire(stream, ctx) {
    return ctx.toWire(transfer(stream));
  },
};
```

## Value Categories

Handlers are NOT called for these (fast path):

- **Primitives**: `null`, `undefined`, `boolean`, `number`, `string`, `bigint`, `symbol`
- **Immutable built-ins**: `Date`, `RegExp` (structured clone handles these)
- **Functions**: Always proxied (can't be cloned)
- **Existing wire markers**: `proxy()` markers, `handle()` markers, proxy properties

Handlers ARE called for:

- **Plain objects**: `{...}` — after checking it's not a marker
- **Arrays**: `[...]`
- **Class instances**: Custom classes, built-in classes (Map, Set, etc.)

## Matching Order

1. First registered handler that returns `true` from `canHandle()` wins
2. If no handler matches, default behavior applies:
   - Plain objects/arrays: clone (traverse in nested mode)
   - Class instances: proxy the whole thing

## Configuration

```typescript
interface Options {
  nestedProxies?: boolean;
  debug?: boolean;
  handlers?: Handler[]; // NEW
}

// Both sides must use compatible handlers
expose(service, endpoint, {handlers: [mapHandler, setHandler]});
wrap<Service>(endpoint, {handlers: [mapHandler, setHandler]});
```

## Built-in Handler Examples

### Map Handler (Proxy Mode — Mutable)

```typescript
const mapProxyHandler: Handler<Map<unknown, unknown>> = {
  wireType: 'handler:map-proxy',
  canHandle: (v): v is Map<unknown, unknown> => v instanceof Map,
  toWire(value, ctx) {
    // Proxy the Map — methods like get/set work remotely
    return ctx.toWire(proxy(value));
  },
  // No fromWire needed — it's a proxy
};
```

### Map Handler (Clone Mode — Immutable Copy)

```typescript
interface MapWire {
  [WIRE_TYPE]: 'handler:map';
  entries: Array<[WireValue, WireValue]>;
}

const mapCloneHandler: Handler<Map<unknown, unknown>, MapWire> = {
  wireType: 'handler:map',
  canHandle: (v): v is Map<unknown, unknown> => v instanceof Map,
  toWire(value, ctx) {
    // Return fully-formed wire value with custom wire type
    return {
      [WIRE_TYPE]: 'handler:map',
      entries: [...value.entries()].map(([k, v]) => [
        ctx.toWire(k),
        ctx.toWire(v),
      ]),
    };
  },
  fromWire(wire, ctx) {
    return new Map(
      wire.entries.map(([k, v]) => [ctx.fromWire(k), ctx.fromWire(v)]),
    );
  },
};
```

### Set Handler (Clone Mode)

```typescript
interface SetWire {
  [WIRE_TYPE]: 'handler:set';
  values: Array<WireValue>;
}

const setCloneHandler: Handler<Set<unknown>, SetWire> = {
  wireType: 'handler:set',
  canHandle: (v): v is Set<unknown> => v instanceof Set,
  toWire(value, ctx) {
    return {
      [WIRE_TYPE]: 'handler:set',
      values: [...value].map((v) => ctx.toWire(v)),
    };
  },
  fromWire(wire, ctx) {
    return new Set(wire.values.map((v) => ctx.fromWire(v)));
  },
};
```

### ReadableStream Handler (Transfer)

```typescript
const readableStreamHandler: Handler<ReadableStream> = {
  wireType: 'readable-stream',
  canHandle: (v): v is ReadableStream => v instanceof ReadableStream,
  toWire(stream, ctx) {
    return ctx.toWire(transfer(stream));
  },
  // No fromWire needed — transferred streams arrive as-is
};
```

### WritableStream Handler (Transfer)

```typescript
const writableStreamHandler: Handler<WritableStream> = {
  wireType: 'writable-stream',
  canHandle: (v): v is WritableStream => v instanceof WritableStream,
  toWire(stream, ctx) {
    return ctx.toWire(transfer(stream));
  },
};
```

### ArrayBuffer Handler (Transfer)

For auto-transferring ArrayBuffers (opt-in, since transfer neuters the original):

```typescript
const arrayBufferTransferHandler: Handler<ArrayBuffer> = {
  wireType: 'transfer:array-buffer',
  canHandle: (v): v is ArrayBuffer => v instanceof ArrayBuffer,
  toWire(buffer, ctx) {
    return ctx.toWire(transfer(buffer));
  },
};
```

## Subscription Handlers

Some handlers need to send updates outside of RPC calls. For example, a signal
handler must push updates when signal values change on the sender side.

The handler lifecycle provides this capability:

```typescript
class SignalHandler implements Handler<Signal, WireSignal> {
  wireType = 'signal';
  #ctx: HandlerConnectionContext | undefined;
  #signals = new Map<number, Signal>();

  // Called when handler is attached to connection
  connect(ctx: HandlerConnectionContext) {
    this.#ctx = ctx;
    // Set up a watcher that sends updates when signals change
    this.#watcher = new Signal.subtle.Watcher(() => {
      this.#flushUpdates();
    });
  }

  // Called when connection closes
  disconnect() {
    this.#ctx = undefined;
    this.#watcher?.unwatch();
    this.#signals.clear();
  }

  // Called when a message arrives for this wireType
  onMessage(payload: unknown) {
    if (isSignalUpdate(payload)) {
      // Update local signal with new value
      this.#signals.get(payload.id)?._update(payload.value);
    }
  }

  canHandle(v): v is Signal {
    return v instanceof Signal.State || v instanceof Signal.Computed;
  }

  toWire(signal, ctx) {
    const id = this.#registerSignal(signal);
    return {
      [WIRE_TYPE]: 'signal',
      id,
      value: ctx.toWire(signal.get()),
    };
  }

  fromWire(wire, ctx) {
    return new RemoteSignal(wire.id, ctx.fromWire(wire.value));
  }

  #flushUpdates() {
    // Collect changed signals and send batch update
    const updates = this.#collectPendingUpdates();
    if (updates.length > 0) {
      this.#ctx?.sendMessage({type: 'signal:batch', updates});
    }
  }
}
```

The key points:

1. **`connect(ctx)`** is called when `expose()` or `wrap()` attaches the handler
2. **`ctx.sendMessage()`** serializes the payload through `toWire` and sends it
3. **`onMessage()`** receives messages sent by the remote handler (already deserialized)
4. **`disconnect()`** is called when `Connection.close()` is invoked
   return buffer;
   },
   };

````

## Performance Considerations

### Fast Path (No Handlers)

When `handlers` is empty or undefined:

- Skip all handler checks
- Use existing optimized paths

### With Handlers

Traversal only happens when:

1. `handlers.length > 0`, AND
2. Value is an object (not primitive)

For each candidate value:

```typescript
// Fast exit for primitives
if (value === null || typeof value !== 'object') {
  return value;
}

// Check handlers (first match wins)
for (const handler of handlers) {
  if (handler.canHandle(value)) {
    return handler.toWire(value, context);
  }
}

// Default behavior...
````

### Type Checks in canHandle()

Handlers should use fast checks:

```typescript
// Good: single instanceof check
canHandle: (v): v is Map => v instanceof Map,

// Good: constructor check
canHandle: (v): v is MyClass => v?.constructor === MyClass,

// Avoid: expensive prototype walks, property enumeration
```

## Traversal Control

Handlers have **full control** over traversal. There's no automatic traversal
of handler results — what you return is what goes on the wire (after tagging).

**To traverse nested values**, call `ctx.toWire()`:

```typescript
toWire(value, ctx) {
  return {
    entries: [...value.entries()].map(([k, v]) => [
      ctx.toWire(k),    // Recursively process
      ctx.toWire(v),    // Recursively process
    ]),
  };
}
```

**To skip traversal**, just don't call `ctx.toWire()`:

```typescript
toWire(value, ctx) {
  // Return raw data — no nested processing
  return { data: value.toJSON() };
}
```

### Shallow+1 Pattern

A handler could implement "proxy nested objects one level deep":

```typescript
const shallowPlusOne: Handler<object> = {
  wireType: 'handler:shallow-plus-one',
  canHandle: (v): v is object => isPlainObject(v),
  toWire(value, ctx) {
    const result: Record<string, WireValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'object' && v !== null) {
        // Proxy objects one level down
        result[k] = ctx.toWire(proxy(v));
      } else {
        // Primitives pass through
        result[k] = v;
      }
    }
    return result;
  },
  fromWire(wire, ctx) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(wire)) {
      result[k] = ctx.fromWire(v);
    }
    return result;
  },
};
```

## Open Questions

### 1. Handler Type Safety

Can we make handlers influence the return type?

```typescript
// Ideal: handler registry affects Remote<T> transformation
const remote = wrap<Service>(endpoint, {
  handlers: [mapHandler], // Maps stay as Map, not proxied
});
```

This is probably too complex for now. Start with runtime-only handlers.

### 2. Both Sides Must Match

Handlers must be configured on both sides:

- Sender uses handler to serialize
- Receiver needs same handler to deserialize

Should we validate this? Options:

- **Trust the developer** — document the requirement
- **Runtime check** — send handler names in handshake
- **Hash check** — hash handler configs and compare

**Recommendation**: Trust + document for now. Handshake can come later.

## Implementation Plan

1. **Phase 1**: Core handler infrastructure
   - Handler interface
   - Handler invocation in toWireValue/fromWireValue
   - Fast path when no handlers

2. **Phase 2**: Built-in handlers (separate package?)
   - `@supertalk/handlers` or included in core
   - Map, Set (proxy mode)
   - Map, Set (clone mode)
   - ReadableStream, WritableStream (transfer)
   - ArrayBuffer (transfer)

3. **Phase 3**: Signals integration ✅
   - TC39 Signal handler
   - Subscription lifecycle management

## Appendix: Wire Value Flow

```
                      #toWire()
Local Value ──────────────────────────> Wire Value
     │                                       │
     │  1. Check proxy() marker → proxy      │
     │  2. Check handle() marker → handle    │
     │  3. Check function → proxy            │
     │  4. Check primitive → pass-through    │
     │  5. Check existing remote → proxy     │
     │  6. Check promise → WirePromise       │
     │  7. >>> Check handlers <<<            │
     │     - canHandle()? → toWire()         │
     │     - Return handler's wire value     │
     │  8. Array/plain object → traverse?    │
     │  9. Class instance → proxy            │
     │                                       │
     └───────────────────────────────────────┘

                    #fromWire()
Wire Value ──────────────────────────> Local Value
     │                                       │
     │  1. WireProxy → create/get proxy      │
     │  2. WirePromise → create promise      │
     │  3. WireProxyProperty → resolve       │
     │  4. WireThrown → throw error          │
     │  5. >>> Handler wireType? <<<         │
     │     - Look up handler by wireType     │
     │     - Call fromWire()                 │
     │  6. Raw value → traverse if nested    │
     │                                       │
     └───────────────────────────────────────┘
```

### ToWireContext Implementation

The context passed to handlers wraps Connection methods:

```typescript
// Simplified — actual implementation is inline in Connection
const toWireContext: ToWireContext = {
  toWire(value: unknown, key?: string): WireValue {
    const path = key ? `${currentPath}.${key}` : currentPath;
    return connection.#toWire(value, path, transfers);
  },
};
```
