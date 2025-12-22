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
   * Used to route deserialization. Convention: 'handler:<name>'
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
   * - ctx.proxy(value) — proxy the value (returns WireProxy)
   * - ctx.process(value, path) — recursively process nested values
   * - ctx.promise(promise) — register a promise (returns WirePromise)
   *
   * Return either:
   * - A wire value from a context method (proxy, promise)
   * - A custom wire object (will be tagged with handler's wireType)
   */
  serialize(value: T, ctx: SerializeContext): WireValue;

  /**
   * Deserialize a value from wire format.
   * Only called for custom wire objects (not proxy/promise results).
   * The wire object is the custom data you returned from serialize().
   */
  deserialize?(wire: W, ctx: DeserializeContext): T;
}
```

### SerializeContext

Handlers use context methods to create well-formed wire values. Handlers never
deal with IDs directly — the context handles all registration and bookkeeping.

```typescript
interface SerializeContext {
  /**
   * Proxy a value — creates a remote reference.
   * Handles registration, ID assignment, and round-trip detection.
   */
  proxy(value: object): WireProxy;

  /**
   * Register a promise for remote resolution.
   */
  promise(value: Promise<unknown>): WirePromise;

  /**
   * Recursively process a nested value.
   * Applies handlers and default behavior, returns wire-safe value.
   * @param key Optional key/index for error path building
   */
  process(value: unknown, key?: string | number): WireValue;

  /**
   * Add a value to the transfer list.
   * Transferred values are moved (not copied) across the boundary.
   * Use for ArrayBuffer, MessagePort, ReadableStream, etc.
   */
  transfer(value: Transferable): void;
}
```

### DeserializeContext

```typescript
interface DeserializeContext {
  /**
   * Recursively process a nested wire value.
   * Handles proxies, promises, and nested handler values.
   */
  process(wire: WireValue): unknown;
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
transferables just need to add to the transfer list; deserialization is automatic.

```typescript
// Simple stream handler — no deserialize needed
const readableStreamHandler: Handler<ReadableStream> = {
  wireType: 'transfer:readable-stream',
  canHandle: (v): v is ReadableStream => v instanceof ReadableStream,
  serialize(stream, ctx) {
    ctx.transfer(stream);
    return stream; // Return as-is, postMessage handles it
  },
};
```

## Value Categories

Handlers are NOT called for these (fast path):

- **Primitives**: `null`, `undefined`, `boolean`, `number`, `string`, `bigint`, `symbol`
- **Immutable built-ins**: `Date`, `RegExp` (structured clone handles these)
- **Functions**: Always proxied (can't be cloned)
- **Existing wire markers**: `LocalProxy`, proxy properties

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
  serialize(value, ctx) {
    // Proxy the Map — methods like get/set work remotely
    return ctx.proxy(value);
  },
  // No deserialize needed — it's a proxy
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
  serialize(value, ctx) {
    // Return fully-formed wire value with custom wire type
    return {
      [WIRE_TYPE]: 'handler:map',
      entries: [...value.entries()].map(([k, v]) => [
        ctx.process(k),
        ctx.process(v),
      ]),
    };
  },
  deserialize(wire, ctx) {
    return new Map(
      wire.entries.map(([k, v]) => [ctx.process(k), ctx.process(v)]),
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
  serialize(value, ctx) {
    return {
      [WIRE_TYPE]: 'handler:set',
      values: [...value].map((v) => ctx.process(v)),
    };
  },
  deserialize(wire, ctx) {
    return new Set(wire.values.map((v) => ctx.process(v)));
  },
};
```

### ReadableStream Handler (Transfer)

```typescript
const readableStreamHandler: Handler<ReadableStream> = {
  wireType: 'readable-stream',
  canHandle: (v): v is ReadableStream => v instanceof ReadableStream,
  serialize(stream, ctx) {
    ctx.transfer(stream);
    return {
      [WIRE_TYPE]: 'readable-stream',
      stream,
    };
  },
  deserialize(wire) {
    return wire.stream;
  },
};
```

### WritableStream Handler (Transfer)

```typescript
const writableStreamHandler: Handler<WritableStream> = {
  wireType: 'writable-stream',
  canHandle: (v): v is WritableStream => v instanceof WritableStream,
  serialize(stream, ctx) {
    ctx.transfer(stream);
    return {
      [WIRE_TYPE]: 'writable-stream',
      stream,
    };
  },
  deserialize(wire) {
    return wire.stream;
  },
};
```

### ArrayBuffer Handler (Transfer)

For auto-transferring ArrayBuffers (opt-in, since transfer neuters the original):

```typescript
const arrayBufferTransferHandler: Handler<ArrayBuffer> = {
  wireType: 'transfer:array-buffer',
  canHandle: (v): v is ArrayBuffer => v instanceof ArrayBuffer,
  serialize(buffer, ctx) {
    ctx.transfer(buffer);
    return buffer;
  },
};
```

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
    return handler.serialize(value, context);
  }
}

// Default behavior...
```

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

**To traverse nested values**, call `ctx.process()`:

```typescript
serialize(value, ctx) {
  return {
    entries: [...value.entries()].map(([k, v]) => [
      ctx.process(k),    // Recursively process
      ctx.process(v),    // Recursively process
    ]),
  };
}
```

**To skip traversal**, just don't call `ctx.process()`:

```typescript
serialize(value, ctx) {
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
  serialize(value, ctx) {
    const result: Record<string, WireValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'object' && v !== null) {
        // Proxy objects one level down
        result[k] = ctx.proxy(v);
      } else {
        // Primitives pass through
        result[k] = v;
      }
    }
    return result;
  },
  deserialize(wire, ctx) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(wire)) {
      result[k] = ctx.process(v);
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

3. **Phase 3**: Signals integration
   - TC39 Signal handler
   - Subscription lifecycle management

## Appendix: Wire Value Flow

```
                    toWireValue()
Local Value ──────────────────────────> Wire Value
     │                                       │
     │  1. Check LocalProxy marker → proxy   │
     │  2. Check function → proxy            │
     │  3. Check primitive → pass-through    │
     │  4. Check existing remote → proxy     │
     │  5. Check promise → WirePromise       │
     │  6. >>> Check handlers <<<            │
     │     - canHandle()? → serialize()      │
     │     - Return handler's wire value     │
     │  7. Array/plain object → traverse?    │
     │  8. Class instance → proxy            │
     │                                       │
     └───────────────────────────────────────┘

                   fromWireValue()
Wire Value ──────────────────────────> Local Value
     │                                       │
     │  1. WireProxy → create/get proxy      │
     │  2. WirePromise → create promise      │
     │  3. WireProxyProperty → resolve       │
     │  4. WireThrown → throw error          │
     │  5. >>> Handler wireType? <<<         │
     │     - Look up handler by wireType     │
     │     - Call deserialize()              │
     │  6. Raw value → traverse if nested    │
     │                                       │
     └───────────────────────────────────────┘
```

### SerializeContext Implementation

The context passed to handlers wraps Connection methods:

```typescript
class SerializeContextImpl implements SerializeContext {
  #connection: Connection;
  #transferList: Transferable[];
  #path: string;

  proxy(value: object): WireProxy {
    // Check round-trip first
    const existingId = this.#connection.getRemoteId(value);
    if (existingId !== undefined) {
      return {[WIRE_TYPE]: 'proxy', proxyId: existingId};
    }
    const proxyId = this.#connection.registerLocal(value);
    return {[WIRE_TYPE]: 'proxy', proxyId};
  }

  promise(value: Promise<unknown>): WirePromise {
    const promiseId = this.#connection.registerPromise(value);
    return {[WIRE_TYPE]: 'promise', promiseId};
  }

  process(value: unknown, path: string): WireValue {
    return this.#connection.toWireValue(value, `${this.#path}.${path}`);
  }

  transfer(value: Transferable): void {
    this.#transferList.push(value);
  }
}
```
