# @supertalk/core

A type-safe, unified client/server communication library for:

- Web Workers and Service Workers
- Iframes
- Node.js worker threads

## Overview

Workers are great for offloading work from the main thread, but the raw `postMessage` API leaves you to build everything yourself—request/response correlation, object identity tracking, memory management for remote references, and all the dispatch logic. You lose the ergonomics of normal function calls.

Supertalk handles all of that, letting you **expose rich, high-level APIs across workers** with virtually no boilerplate. Call methods, pass callbacks, await promises, and interact with class instances as if they were local objects:

```ts
// In your worker
expose(myService, self);

// From your main thread
const service = wrap<MyService>(worker);
const widget = await service.createWidget();
await widget.onClick(() => console.log('clicked!'));
```

- **Type-safe** — Your IDE knows exactly what's proxied vs cloned
- **Ergonomic** — Callbacks, promises, and classes just work
- **Bidirectional** — The same patterns work in both directions
- **Fast & small** — ~2 kB brotli-compressed, zero dependencies
- **Composable** — Nested objects, sub-services, no special cases

## Installation

```bash
npm install @supertalk/core
```

## Design Principles

### Type-Safe Proxying with `proxy()`

Supertalk provides explicit control over what gets proxied via the `proxy()`
function. This makes the types accurate — you know exactly what's proxied and
what's cloned just by looking at the types:

```ts
import {expose, proxy} from '@supertalk/core';
import type {LocalProxy} from '@supertalk/core';

const service = {
  // Explicitly proxied — RemoteProxy<Widget> on the client
  createWidget(): LocalProxy<Widget> {
    return proxy(new Widget());
  },
  // Plain object — cloned, types match exactly
  getData(): {value: number} {
    return {value: 42};
  },
};
```

### Two Modes: Shallow and Nested

- **Shallow mode** (default): Maximum performance, only top-level function
  arguments are proxied. Nested functions/promises fail with `DataCloneError`.
- **Nested mode** (`nestedProxies: true`): Full payload traversal. Functions
  and promises anywhere in the graph are auto-proxied. Class instances still
  require explicit `proxy()` markers for type safety.

In both modes, **plain objects** (`{...}`) are traversed for nested proxy
markers, functions, and promises, while **class instances** and **objects with
custom prototypes** are passed directly to structured clone. This means a plain
object with a nested callback works in nested mode, but a class instance with a
callback field would fail. Use `proxy()` if you need a class instance's methods
available remotely, or a handler to convert the instance into something
cloneable.

### Per-Connection Configuration

All configuration is scoped to individual connections via `expose()` and
`wrap()`, rather than using global state. This keeps connections independent
and makes testing straightforward.

### Debugging Utilities

Debugging `DataCloneError` can be tricky — the browser says "could not be
cloned" without telling you _where_ in your data the problem is.

Supertalk provides a `debug` option that traverses your data before sending and
throws a `NonCloneableError` with the exact path to the problematic value:

```ts
const remote = wrap<Service>(endpoint, {debug: true});

// Now when something fails to clone, you get:
// NonCloneableError: Function at "config.onChange" cannot be cloned.
// Use nestedProxies: true to auto-proxy nested functions and promises.
```

### Future Goals

- **Signals**: Reactive state synchronization via TC39 Signals

## Transferables with `transfer()`

Some objects like `ArrayBuffer`, `MessagePort`, `ReadableStream`, and
`WritableStream` can be **transferred** rather than cloned. Transferring moves
the object to the other side (the original becomes unusable), but is much
faster for large data.

Use `transfer()` to mark values for transfer:

```ts
import {transfer} from '@supertalk/core';

const service = {
  // Transfer the buffer (fast, original neutered)
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

## Handlers

Handlers provide pluggable serialization for custom types. Use them for:

- **Collections**: Maps, Sets that should clone or proxy
- **Streams**: ReadableStream/WritableStream transferred across the boundary
- **Custom types**: Domain-specific serialization

### Stream Handler

Supertalk provides a separate handler for transferring streams:

```ts
import {wrap, expose} from '@supertalk/core';
import {streamHandler} from '@supertalk/core/handlers/streams.js';

// Both sides must use the same handlers
expose(service, self, {handlers: [streamHandler]});
const remote = wrap<typeof service>(worker, {handlers: [streamHandler]});

// Now streams transfer automatically
const stream = await remote.getDataStream();
for await (const chunk of stream) {
  console.log(chunk);
}
```

### Custom Handlers

Create handlers for any type:

```ts
import {
  WIRE_TYPE,
  type Handler,
  type ToWireContext,
  type FromWireContext,
} from '@supertalk/core';

// A handler that clones Maps by converting to/from arrays
const mapHandler: Handler<Map<unknown, unknown>> = {
  wireType: 'my-app:map',

  canHandle(value): value is Map<unknown, unknown> {
    return value instanceof Map;
  },

  toWire(map, ctx: ToWireContext) {
    // ctx.toWire() recursively handles nested values
    const entries = [...map.entries()].map(([k, v]) => [
      ctx.toWire(k),
      ctx.toWire(v),
    ]);
    return {
      [WIRE_TYPE]: 'my-app:map',
      entries,
    };
  },

  fromWire(wire, ctx: FromWireContext) {
    return new Map(
      wire.entries.map(([k, v]) => [ctx.fromWire(k), ctx.fromWire(v)]),
    );
  },
};

// Use on both sides
expose(service, self, {handlers: [mapHandler]});
const remote = wrap<typeof service>(worker, {handlers: [mapHandler]});
```

### Handler Context Methods

The `ToWireContext` passed to `toWire()` provides:

- `ctx.toWire(value)` — Recursively process nested values

The `FromWireContext` passed to `fromWire()` provides:

- `ctx.fromWire(wire)` — Recursively process nested wire values

## Quick Start

```ts
// worker.ts (exposed side)
import {expose} from '@supertalk/core';

const service = {
  add(a: number, b: number): number {
    return a + b;
  },
  async fetchData(url: string): Promise<string> {
    const res = await fetch(url);
    return res.text();
  },
};

expose(service, self);

// main.ts (wrapped side)
import {wrap} from '@supertalk/core';

const worker = new Worker('./worker.ts');
const remote = wrap<typeof service>(worker);

// Methods become async
const result = await remote.add(1, 2); // 3
```

## The `proxy()` Function

Use `proxy()` to explicitly mark values that should be proxied rather than
cloned. This is the key to type-safe remote APIs.

### When to Use `proxy()`

**Use `proxy()` when returning:**

1. **Mutable objects** — The remote side should see updates

   ```ts
   createCounter(): LocalProxy<Counter> {
     return proxy(new Counter());  // Mutations visible remotely
   }
   ```

2. **Large graphs** — Avoid cloning expensive data structures

   ```ts
   getDocument(): LocalProxy<Document> {
     return proxy(this.doc);  // Don't clone the entire tree
   }
   ```

3. **Class instances with methods** — Preserve the prototype API
   ```ts
   createWidget(): LocalProxy<Widget> {
     return proxy(new Widget());  // widget.activate() works remotely
   }
   ```

**Don't use `proxy()` for:**

- Immutable data (cloning is fine, avoids round-trips)
- Small DTOs / config objects
- Anything the remote side will just read once

### LocalProxy and RemoteProxy Types

```ts
import {proxy} from '@supertalk/core';
import type {LocalProxy, RemoteProxy} from '@supertalk/core';

// On the exposed side, proxy() returns LocalProxy<T>
const service = {
  createWidget(): LocalProxy<Widget> {
    const widget = new Widget();
    widget.setup(); // Can use normally before returning
    return proxy(widget);
  },
};

// LocalProxy has a .value property for local access
const wrapped = proxy(new Counter());
wrapped.value.increment(); // Access the underlying object
```

On the receiving side, `LocalProxy<T>` becomes `RemoteProxy<T>` where all
property and method access is async:

```ts
// RemoteProxy<Widget> has all properties async
const widget = await remote.createWidget();
await widget.name; // Promise<string>
await widget.activate(); // Promise<void>
```

## Value Handling: Proxied vs Cloned

When values cross the communication boundary, Supertalk decides whether to
**clone** (copy the value) or **proxy** (create a remote reference).

| Value Type                                       | Shallow Mode | Nested Mode |
| ------------------------------------------------ | ------------ | ----------- |
| Primitives                                       | ✅ Cloned    | ✅ Cloned   |
| Plain objects `{...}`                            | ✅ Cloned    | ✅ Cloned   |
| Arrays                                           | ✅ Cloned    | ✅ Cloned   |
| Functions (top-level)                            | 🛜 Proxied   | 🛜 Proxied  |
| Functions (nested)                               | ❌ Error     | 🛜 Proxied  |
| Promises (top-level return)                      | 🛜 Proxied   | 🛜 Proxied  |
| Promises (nested)                                | ❌ Error     | 🛜 Proxied  |
| `proxy()` wrapped values                         | 🛜 Proxied   | 🛜 Proxied  |
| `proxy()` wrapped values (nested)                | ❌ Error     | 🛜 Proxied  |
| Class instances & objects with custom prototypes | ⚠️ Cloned\*  | ⚠️ Cloned\* |
| Other structured cloneable objects               | ✅ Cloned    | ✅ Cloned   |

\* After handling special values like functions, arrays, plain objects, and
proxies, values are passed to [the structured clone
algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm).
Certain native objects, like Dates and RegExps, are cloned and automatically
re-created on the receiving end. Everything else is copied, but loses private
fields, prototype, etc. For other classes, mutable objects, and objects with
custom prototypes, use `proxy()` to preserve methods and behavior.

### Callbacks

Functions passed as **top-level arguments** are always proxied (no nested mode
needed):

```ts
// Exposed side
const service = {
  forEach(items: number[], callback: (item: number) => void) {
    for (const item of items) {
      callback(item); // Calls back to wrapped side
    }
  },
};

// Wrapped side
await remote.forEach([1, 2, 3], (item) => {
  console.log(item); // Runs locally
});
```

### Nested Mode Example

```ts
// On exposed side
expose(service, self, {nestedProxies: true});

const service = {
  getData() {
    return {
      name: 'example', // cloned (primitive)
      items: [1, 2, 3], // cloned (array)
      process: (x) => x * 2, // auto-proxied (function)
      widget: proxy(new Widget()), // explicitly proxied (class)
    };
  },
};

// On wrapped side
const remote = wrap<typeof service>(worker, {nestedProxies: true});

const data = await remote.getData();
data.name; // 'example' (local copy)
data.items; // [1, 2, 3] (local copy)
await data.process(5); // 10 (calls back to exposed side)
await data.widget.activate(); // RemoteProxy<Widget>
```

## TypeScript Types

### `Remote<T>`

The primary type for service proxies. Transforms all methods to async:

```ts
import {wrap} from '@supertalk/core';

interface MyService {
  add(a: number, b: number): number;
  createWidget(): LocalProxy<Widget>;
  getData(): {value: number};
}

const remote = wrap<MyService>(worker);
// Remote<MyService> = {
//   add(a, b): Promise<number>;
//   createWidget(): Promise<RemoteProxy<Widget>>;
//   getData(): Promise<{ value: number }>;
// }
```

### `RemoteNested<T>`

Like `Remote<T>`, but for nested mode. Arguments also accept remoted versions
(for round-trip proxy handling):

```ts
const remote = wrap<MyService>(worker, {nestedProxies: true});
// Returns RemoteNested<MyService>
```

### `Remoted<T>`

Recursively transforms a type for remote access:

- `LocalProxy<T>` → `RemoteProxy<T>`
- Functions → async functions
- Objects/Arrays → recurse into properties
- Primitives → unchanged

```ts
import type {Remoted, LocalProxy} from '@supertalk/core';

type T1 = Remoted<LocalProxy<Widget>>; // RemoteProxy<Widget>
type T2 = Remoted<() => number>; // () => Promise<number>
type T3 = Remoted<{fn: () => void}>; // { fn: () => Promise<void> }
```

### `RemoteProxy<T>` (alias: `Proxied<T>`)

All property and method access becomes async. This is what you receive when
the other side sends a `LocalProxy<T>`:

```ts
import type {RemoteProxy} from '@supertalk/core';

class Counter {
  name: string;
  count = 0;
  increment(): number {
    return ++this.count;
  }
}

// RemoteProxy<Counter>:
// {
//   name: Promise<string>;
//   count: Promise<number>;
//   increment: () => Promise<number>;
// }
```

## Memory Management

Proxied objects are tracked with registries on both sides:

- **Source side**: Holds strong references to objects until the remote releases
  them
- **Consumer side**: Holds weak references; when a proxy is garbage collected,
  the source is notified to release

This prevents memory leaks while ensuring objects stay alive as long as needed.

## Options

```ts
import type {Handler} from '@supertalk/core';

interface Options {
  /**
   * Enable nested proxy handling.
   *
   * - false (default): Only top-level function arguments are proxied.
   * - true: Full traversal; functions/promises are auto-proxied anywhere.
   */
  nestedProxies?: boolean;

  /**
   * Enable debug mode for better error messages.
   * Traverses data to find non-cloneable values and report their paths.
   */
  debug?: boolean;

  /**
   * Custom handlers for serializing/deserializing specific types.
   * Handlers are checked in order; first match wins.
   */
  handlers?: Array<Handler>;
}
```

## License

MIT
