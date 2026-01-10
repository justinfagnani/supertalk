# Supertalk

A type-safe, unified communication library for Web Workers, Iframes, and Node.js
worker threads.

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
- **Standard modules:** ESM-only, no CommonJS

## Installation

```bash
npm install supertalk
```

This package re-exports `@supertalk/core`. As additional packages are added to
the Supertalk ecosystem, they may be included here as well.

## Quick Start

**worker.ts** (exposed side):

```ts
import {expose} from 'supertalk';

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

**main.ts** (wrapped side):

```ts
import {wrap} from 'supertalk';

const worker = new Worker('./worker.ts');
const remote = await wrap<typeof service>(worker);

// Methods become async
const result = await remote.add(1, 2); // 3
```

## Core Concepts

### Requests and Responses

Most cross-worker communication follows a request/response pattern, but
`postMessage()` only sends one-way messages. Matching responses to requests is
left as an exercise to the developer. Supertalk builds a request/response
protocol on top of `postMessage()`, so you can call methods and await results
naturally.

### Clones vs Proxies

`postMessage()` copies payloads via the structured clone algorithm, which only
supports a limited set of types. Functions are completely unsupported, and class
instances lose their prototypes—so things like Promises don't survive the trip.

Supertalk addresses this by _proxying_ values that can't be cloned. A proxied
object stays on its original side; the other side gets a lightweight proxy that
forwards calls back. This is how functions, promises, and class instances work
across the message boundary.

### Shallow vs Deep Proxying

By default, Supertalk only proxies objects passed directly to or returned from
method calls. This keeps messages fast. If you need proxies nested anywhere in a
payload, set `nestedProxies: true` to traverse the full object graph.

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
import {expose, proxy} from 'supertalk';

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
import {transfer} from 'supertalk';

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
- `transferables`: Optional array of transferables. If omitted, `value` is
  assumed to be the transferable.

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
import {streamHandler} from 'supertalk/handlers/streams.js';

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

## Ecosystem

This package re-exports `@supertalk/core`. Additional packages are available for
extended functionality:

| Package                                                               | Description                                       |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| [@supertalk/signals](https://www.npmjs.com/package/@supertalk/signals) | TC39 Signals integration for reactive state sync |

## Why Supertalk?

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

Supertalk is inspired by [Comlink](https://github.com/GoogleChromeLabs/comlink)
but improves on it:

- **Automatic proxying:** Functions/promises are auto-proxied without special
  wrappers
- **Nested support:** `nestedProxies` mode allows proxies anywhere in the
  payload
- **Debug mode:** Reports exactly where non-serializable values are
- **Symmetric:** Both ends use the same internal architecture
- **Type-safe:** Better TypeScript inference for what's proxied vs cloned

## License

MIT
