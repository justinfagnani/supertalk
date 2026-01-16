# Supertalk

> [!WARNING]
> This is a pre-release package under active development. APIs may change without
> notice between versions.

A type-safe, unified communication library for Web Workers, Iframes, and Node.js
worker threads.

**Supertalk turns workers' low-level message passing into a high-level,
type-safe RPC layer—so you can call methods, pass callbacks, and await promises
as if they were local.**

Supertalk is built to be a joy to use and deploy:

- **Type-safe:** Your IDE knows exactly what's proxied vs cloned
- **Ergonomic:** Callbacks, promises, and classes just work
- **Bidirectional:** The same types and patterns work in both directions
- **Fast & small:** ~2.4 kB brotli-compressed, zero dependencies
- **Composable & extendable:** Non-global configuration, nested objects,
  services are just classes, composable transport handlers
- **Standard modules:** ESM-only, no CommonJS
- **Modern JavaScript:** Published as ES2024, targeting current browsers and
  Node.js 20+

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

// The proxy provides async access to properties and methods
const count = await widget.count;
const hello = await widget.sayHello();
```

### Opaque Handles with `handle()`

When you need to pass a reference without exposing any remote interface, use
`handle()`. Handles are opaque tokens — they can be passed around and back, but
provide no way to access properties or methods remotely.

```ts
import {expose, handle, getHandleValue, type Handle} from 'supertalk';

class Session {
  constructor(public id: string) {}
}

const service = {
  createSession(id: string) {
    return handle(new Session(id)); // Opaque handle
  },
  getSessionId(session: Handle<Session>) {
    // Extract the value on the owning side
    return getHandleValue(session).id;
  },
};
```

```ts
// Client side
const session = await remote.createSession('abc'); // Handle<Session>
// session is opaque — no property access
const id = await remote.getSessionId(session); // Pass it back
```

### Extracting Values from Proxies and Handles

Both `proxy()` and `handle()` create wrappers that work the same on both sides.
On the side that created the proxy/handle, you can extract the underlying value:

```ts
import {
  proxy,
  getProxyValue,
  handle,
  getHandleValue,
  type AsyncProxy,
  type Handle,
} from 'supertalk';

const service = {
  // Return a proxied widget
  createWidget() {
    return proxy(new Widget());
  },

  // Accept a proxy and extract its value
  updateWidget(widget: AsyncProxy<Widget>) {
    const w = getProxyValue(widget); // Only works on owning side
    w.refresh();
  },

  // Same pattern works for handles
  processSession(session: Handle<Session>) {
    const s = getHandleValue(session);
    return s.data;
  },
};
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

| Value Type                                       | Shallow Mode   | Nested Mode    |
| ------------------------------------------------ | -------------- | -------------- |
| Primitives                                       | ✅ Cloned      | ✅ Cloned      |
| Plain objects `{...}`                            | ✅ Cloned      | ✅ Cloned      |
| Arrays                                           | ✅ Cloned      | ✅ Cloned      |
| Functions (top-level)                            | 🛜 Proxied     | 🛜 Proxied     |
| Functions (nested)                               | ❌ Error       | 🛜 Proxied     |
| Promises (top-level return)                      | 🛜 Proxied     | 🛜 Proxied     |
| Promises (nested)                                | ❌ Error       | 🛜 Proxied     |
| `proxy()` wrapped values (top-level)             | 🛜 Proxied     | 🛜 Proxied     |
| `proxy()` wrapped values (nested)                | ❌ Error       | 🛜 Proxied     |
| `handle()` wrapped values (top-level)            | 🔒 Handle      | 🔒 Handle      |
| `handle()` wrapped values (nested)               | ❌ Error       | 🔒 Handle      |
| `transfer()` wrapped values (top-level)          | 📦 Transferred | 📦 Transferred |
| `transfer()` wrapped values (nested)             | ❌ Error       | 📦 Transferred |
| Class instances & objects with custom prototypes | ⚠️ Cloned\*    | ⚠️ Cloned\*    |
| Other structured cloneable objects               | ✅ Cloned      | ✅ Cloned      |

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

Marks an object to be proxied rather than cloned. Returns an `AsyncProxy<T>`
that provides async access on both sides. Use this for:

- Class instances with methods
- Mutable objects that should be shared
- Large objects to avoid cloning costs

#### `handle(value)`

Marks an object as an opaque handle. Returns a `Handle<T>` that can be passed
around but provides no remote interface. Use this for:

- Session tokens or identifiers
- References to expensive objects
- Graph nodes where you don't want to expose internals

#### `getProxyValue(proxy)` / `getHandleValue(handle)`

Extracts the underlying value from an `AsyncProxy` or `Handle`. Only works on
the side that created the proxy/handle — throws `TypeError` on the remote side.

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
  /**
   * Enable debug mode for better error messages.
   * Throws NonCloneableError with the exact path for nested functions,
   * promises, proxy() markers, and transfer() markers that would fail
   * without nestedProxies: true.
   */
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

The primary type for service proxies returned by `wrap()`. Transforms all
methods to async and properties to `Promise<T>`.

```ts
const remote = await wrap<MyService>(worker);
// remote has type Remote<MyService>
```

#### `AsyncProxy<T>`

The unified proxy type returned by `proxy()`. Works the same on both sides of a
connection — the remote side gets async access to properties and methods, while
the owning side can extract the underlying value with `getProxyValue()`.

```ts
// Service returns an AsyncProxy
createWidget(): AsyncProxy<Widget> {
  return proxy(new Widget());
}

// Client receives the same type
const widget = await remote.createWidget(); // AsyncProxy<Widget>
await widget.name;       // Property access is async
await widget.activate(); // Method calls are async
```

#### `Handle<T>`

An opaque reference type returned by `handle()`. Provides no remote interface —
useful for session tokens, expensive objects, or graph nodes that shouldn't
expose their internals.

```ts
// Service returns a Handle
createSession(): Handle<Session> {
  return handle(new Session());
}

// Client can only pass it back
const session = await remote.createSession(); // Handle<Session>
// session.foo — not allowed, handles are opaque
await remote.useSession(session); // Pass it back
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

### Node.js Worker Threads

For Node.js `worker_threads`, use the `nodeEndpoint` adapter to convert the
Node-style event API (`on`/`off`) to the browser-style API
(`addEventListener`/`removeEventListener`).

**main.ts:**

```ts
import {wrap} from 'supertalk';
import {nodeEndpoint} from 'supertalk/node.js';
import {Worker} from 'node:worker_threads';

const worker = new Worker('./worker.js');
const remote = await wrap<MyService>(nodeEndpoint(worker));

const result = await remote.add(1, 2);
worker.terminate();
```

**worker.ts:**

```ts
import {expose} from 'supertalk';
import {parentPort} from 'node:worker_threads';

const service = {
  add(a: number, b: number) {
    return a + b;
  },
};

// parentPort is a MessagePort which has addEventListener/removeEventListener
expose(service, parentPort!);
```

## Ecosystem

This package re-exports `@supertalk/core`. Additional packages are available for
extended functionality:

| Package                                                                | Description                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------ |
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
