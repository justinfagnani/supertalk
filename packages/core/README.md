# @supertalk/core

A type-safe, unified communication library for Web Workers, Iframes, and Node.js
worker threads.

## Overview

**Supertalk turns workers' low-level message passing into a high-level,
type-safe RPC layer—so you can call methods, pass callbacks, and await promises
as if they were local.**

Supertalk is built to be a joy to use and deploy:

- **Type-safe:** Your IDE knows exactly what's proxied vs cloned
- **Ergonomic:** Callbacks, promises, and classes just work
- **Bidirectional:** The same types and patterns work in both directions
- **Fast & small:** ~2.3 kB brotli-compressed, zero dependencies
- **Composable & extendable:** Non-global configuration, nested objects,
  services are just classes, composable transport handlers
- **Standard modules:** Some people call them "ESM". We don't publish CJS.

## Installation

```bash
npm install @supertalk/core
```

## Quick Start

`worker.ts` (exposed side):

```ts
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
```

`main.ts` (wrapped side):

```ts
import {wrap} from '@supertalk/core';

const worker = new Worker('./worker.ts');
const remote = await wrap<typeof service>(worker);

// Methods become async
const result = await remote.add(1, 2); // 3
```

## Core Features

### Automatic proxying of functions and promises

Functions and promises passed as **top-level arguments or return values** are
always proxied:

```ts
// Exposed side
const service = {
  forEach(items: number[], callback: (item: number) => void) {
    for (const item of items) {
      callback(item); // Calls back to wrapped side
    }
  },
};
```

```ts
// Wrapped side
await remote.forEach([1, 2, 3], (item) => {
  console.log(item); // Runs locally
});
```

All functions are transformed into promise-returning async functions on the
wrapped side. Proxies are released from memory when they're no longer in use by
the wrapped side.

### Object proxying with `proxy()`

Objects are cloned by default. This works well for immutable data objects, but
not for all cases. The `proxy()` function marks an object as needing to be
proxied instead of cloned.

**Use `proxy()` when returning:**

1. **Mutable objects** — The remote side should see updates
2. **Large graphs** — Avoid cloning expensive data structures
3. **Class instances with methods** — Preserve the prototype API

`worker.ts`:

```ts
import {expose, proxy} from '@supertalk/core';

export class Widget {
  count = 42;
  sayHello() {
    return 'hello';
  }
}

expose(
  {
    createWidget() {
      return proxy(new Widget()); // Explicitly proxied
    },
  },
  self,
);
```

`main.ts`:

```ts
const service = await wrap(worker);
const widget = await service.createWidget();

// Instance and prototype APIs are available asynchronously
const count = await widget.count;
const hello = await widget.sayHello();
```

### Nested Objects & Proxies

Supertalk supports two modes for handling nested values:

- **Shallow mode** (default): Maximum performance, only top-level function
  arguments and return values are proxied. Nested functions/promises fail with
  `DataCloneError`.
- **Nested mode** (`nestedProxies: true`): Full payload traversal. Functions and
  promises anywhere in the graph are auto-proxied.

```ts
// On exposed side
expose(service, self, {nestedProxies: true});

const service = {
  getData() {
    return {
      process: (x) => x * 2, // auto-proxied (function)
      widget: proxy(new Widget()), // explicitly proxied (class)
    };
  },
};

// On wrapped side
const remote = await wrap<typeof service>(worker, {nestedProxies: true});
const data = await remote.getData();
await data.process(5); // 10
```

### Transferables with `transfer()`

Use `transfer()` to mark values like `ArrayBuffer`, `MessagePort`, or streams to
be transferred rather than cloned.

```ts
import {transfer} from '@supertalk/core';

const service = {
  getBuffer(): ArrayBuffer {
    const buf = new ArrayBuffer(1024);
    return transfer(buf); // Zero-copy transfer
  },
};
```

### Value Handling Reference

When values cross the communication boundary:

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

\* _Class instances are cloned via structured clone (losing methods) unless
wrapped in `proxy()`._

## API Reference

### Core Functions

#### `expose(target, endpoint, options?)`

Exposes an object or function to the other side.

- `target`: The service object or function to expose.
- `endpoint`: The `Worker`, `MessagePort`, `Window`, or compatible interface.
- `options`: Connection options (see below).

#### `wrap<T>(endpoint, options?)`

Connects to an exposed service and returns a proxy.

- `endpoint`: The `Worker`, `MessagePort`, `Window`, or compatible interface.
- `options`: Connection options (see below).
- Returns: `Promise<Remote<T>>`

#### `proxy(value)`

Marks an object to be proxied rather than cloned. Use this for:

- Class instances with methods
- Mutable objects that should be shared
- Large objects to avoid cloning costs

#### `transfer(value, transferables?)`

Marks a value to be transferred (zero-copy) rather than cloned.

- `value`: The value to send (e.g. `ArrayBuffer`, `MessagePort`).
- `transferables`: Optional array of transferables. If omitted, `value` is assumed to be the transferable.

### Options

```ts
interface Options {
  /** Enable nested proxy handling (default: false) */
  nestedProxies?: boolean;
  /** Enable debug mode for better error messages */
  debug?: boolean;
  /** Custom handlers for serializing/deserializing specific types */
  handlers?: Array<Handler>;
}
```

### Handlers

Handlers provide pluggable serialization for custom types or streams.

**Stream Handler Example:**

```ts
import {streamHandler} from '@supertalk/core/handlers/streams.js';

expose(service, self, {handlers: [streamHandler]});
const remote = await wrap<typeof service>(worker, {handlers: [streamHandler]});
```

**Custom Handlers:** You can create handlers for types like `Map`, `Set`, or
domain objects. See `Handler`, `ToWireContext`, and `FromWireContext` types.

### TypeScript Types

#### `Remote<T>`

The primary type for service proxies. Transforms all methods to async.

```ts
const remote = await wrap<MyService>(worker);
// remote has type Remote<MyService>
```

#### `RemoteProxy<T>`

What you receive when the other side sends a `LocalProxy<T>`. All property and
method access becomes async.

```ts
// RemoteProxy<Counter>:
// {
//   count: Promise<number>;
//   increment: () => Promise<number>;
// }
```

## Advanced Usage

### Debugging

Debugging `DataCloneError` can be tricky. Supertalk provides a `debug` option
that traverses your data before sending and throws a `NonCloneableError` with
the exact path to the problematic value.

```ts
const remote = await wrap<Service>(endpoint, {debug: true});
```

### Memory Management

Proxied objects are tracked with registries on both sides.

- **Source side**: Holds strong references until released.
- **Consumer side**: Holds weak references; when GC'd, notifies source to
  release.

## Benchmarks

Supertalk vs Comlink vs Supertalk with `nestedProxies: true`, measured in
ops/sec (higher is better). Node.js `worker_threads` with `MessageChannel`.

| Benchmark                    | Supertalk | Comlink | ST vs Comlink | Supertalk w/ <br> nestedProxies | nested vs <br> shallow |
| ---------------------------- | --------: | ------: | ------------: | ------------------------------: | ---------------------: |
| Simple String Echo           |   168,597 |  94,543 |         1.78x |                         173,684 |                  1.03x |
| Multiple Arguments (4 nums)  |   163,503 |  84,546 |         1.93x |                         163,420 |                     1x |
| Large Object (~10KB)         |    26,257 |  23,714 |         1.11x |                          12,886 |                  0.49x |
| Large Array (10,000 items)   |       313 |     309 |         1.01x |                             163 |                  0.52x |
| Callback (proxy function)    |     3,742 |   3,469 |         1.08x |                           3,607 |                  0.96x |
| Multiple Callbacks (3 funcs) |     1,748 |   1,576 |         1.11x |                           1,856 |                  1.06x |
| Rapid Sequential (20x burst) |   190,164 | 103,191 |         1.84x |                         179,378 |                  0.94x |

**Notes:**

- Supertalk appears to have lower per-call and per-object overhead, which makes
  it faster in the multiple call and multiple argument cases, and similar in the
  one large object or array cases.
- For simple calls and bursts, Supertalk is ~1.8-1.9x faster than Comlink
- `nestedProxies` mode adds traversal overhead for large payloads. The
  performance impact ranges from negligible for small objects to 2x slower for
  large graphs and arrays.
- Run the benchmarks with: `npm run bench -w @supertalk/core`

## Background

### Why Supertalk?

Workers are great for offloading work, but the raw `postMessage` API is
difficult:

- No built-in request/response (one-way only)
- No error propagation
- No functions or promises (DataCloneError)
- Manual lifetime management
- Manual transfer lists

Supertalk handles all of this: RPC layer, transparent proxying, automatic
lifetime management, and deep traversal.

### Comparison to Comlink

Supertalk is inspired by Comlink but differs in key ways:

- **Automatic proxying:** Functions/promises are auto-proxied.
- **Nested support:** `nestedProxies` mode allows proxies anywhere in the
  payload.
- **Debug mode:** Reports exactly where non-serializable values are.
- **Symmetric:** Both ends use the same `Connection` class.
- **No MessagePorts:** Uses the worker/window directly, making it lighter.

## License

MIT
