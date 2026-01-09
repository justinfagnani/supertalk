# Supertalk

A type-safe, unified communication library for Web Workers, Iframes, and Node.js
worker threads.

**Supertalk turns workers' low-level message passing into a high-level,
type-safe RPC layer—so you can call methods, pass callbacks, and await promises
as if they were local.**

This monorepo contains the core library and planned add-on packages for signals
support, worker pools, and more.

## Features

- **Type-safe:** Your IDE knows exactly what's proxied vs cloned
- **Ergonomic:** Callbacks, promises, and classes just work
- **Bidirectional:** The same types and patterns work in both directions
- **Fast & small:** ~2.3 kB brotli-compressed, zero dependencies
- **Composable & extendable:** Non-global configuration, nested objects,
  services are just classes, composable transport handlers
- **Standard modules:** ESM-only, no CommonJS

## Installation

```bash
npm install @supertalk/core
```

## Quick Start

**worker.ts** (exposed side):

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

**main.ts** (wrapped side):

```ts
import {wrap} from '@supertalk/core';

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
objectstays on its original side; the other side gets a lightweight proxy
forwards calls back. This is how functions, promises, and class instances work
across the message boundary.

### Shallow vs Deep Proxying

By default, Supertalk only proxies objects passed directly to or returned from
method calls. This keeps messages fast. If you need proxies nested anywhere in a
payload, set `nestedProxies: true` to traverse the full object graph.

### Functions & Promises Just Work

Functions and promises passed as arguments or return values are automatically
proxied:

```ts
// Exposed side
const service = {
  async processData(data: Data, onProgress: (percent: number) => void) {
    for (let i = 0; i < data.items.length; i++) {
      await process(data.items[i]);
      onProgress(((i + 1) / data.items.length) * 100);
    }
  },
};

// Wrapped side
await remote.processData(data, (percent) => {
  console.log(`${percent}% complete`); // Runs locally
});
```

### Proxying Objects with `proxy()`

Objects are cloned by default. Use `proxy()` for class instances, mutable
objects, or large data structures:

```ts
import {expose, proxy} from '@supertalk/core';

expose(
  {
    createWidget() {
      return proxy(new Widget()); // Explicitly proxied
    },
  },
  self,
);
```

The `proxy()` helper also tells TypeScript to use a `RemoteProxy<T>` on the
receiving side, so that the type-checker knows that methods are transformed to
be async.

### Transferables with `transfer()`

Zero-copy transfer for `ArrayBuffer`, `MessagePort`, streams, and more:

```ts
import {transfer} from '@supertalk/core';

const service = {
  getBuffer(): ArrayBuffer {
    const buf = new ArrayBuffer(1024);
    return transfer(buf);
  },
};
```

## Packages

| Package                                   | Description                |
| ----------------------------------------- | -------------------------- |
| [@supertalk/core](./packages/core/)       | Core RPC and proxy library |
| [@supertalk/signals](./packages/signals/) | TC39 Signals integration   |

## Why Supertalk?

Workers are great for offloading work, but the raw `postMessage` API is
difficult:

- No built-in request/response (one-way only)
- No error propagation
- No functions or promises (DataCloneError)
- Manual lifetime management
- Manual transfer lists

Supertalk handles all of this: RPC layer, transparent proxying, automatic
lifetime management, and optional deep traversal for complex payloads.

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

## Documentation

- [Goals & Design Rationale](./docs/GOALS.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [API Design](./docs/API-DESIGN.md)
- [Roadmap](./docs/ROADMAP.md)

## License

MIT
