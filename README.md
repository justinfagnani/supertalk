# Supertalk

> [!WARNING]
> This is a pre-release package under active development. APIs may change without
> notice between versions.

A type-safe, unified communication library for Web Workers, Iframes, and Node.js
worker threads.

**Supertalk turns workers' low-level message passing into a high-level,
type-safe RPC layer—so you can call methods, pass callbacks, and await promises
as if they were local.**

- **Type-safe:** Your IDE knows exactly what's proxied vs cloned
- **Ergonomic:** Callbacks, promises, and classes just work
- **Bidirectional:** The same types and patterns work in both directions
- **Fast & small:** ~2.4 kB brotli-compressed, zero dependencies
- **Composable & extendable:** Non-global configuration, nested objects,
  services are just classes, composable transport handlers
- **Standard modules:** ESM-only, no CommonJS

## Installation

```bash
npm install supertalk
```

Or install individual packages:

```bash
npm install @supertalk/core
npm install @supertalk/signals
```

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

## Key Features

- **Functions & promises just work** — Passed as arguments or return values,
  they're automatically proxied
- **Object proxying with `proxy()`** — Mark class instances, mutable objects, or
  large graphs for proxying instead of cloning
- **Opaque handles with `handle()`** — Pass references without exposing an async
  interface
- **Consistent types** — Proxies and handles work the same on both sides of the
  worker boundary, so APIs don't change whether a service is used locally or
  remotely
- **Transferables with `transfer()`** — Zero-copy transfer for `ArrayBuffer`,
  `MessagePort`, streams, and more
- **Shallow or deep proxying** — Default shallow mode for speed;
  `nestedProxies: true` for complex payloads
- **Debug mode** — Reports exactly where non-serializable values are in your
  payload

## Packages

| Package                                   | Description                                      |
| ----------------------------------------- | ------------------------------------------------ |
| [supertalk](./packages/supertalk/)        | Convenience package, re-exports @supertalk/core  |
| [@supertalk/core](./packages/core/)       | Core RPC and proxy library                       |
| [@supertalk/signals](./packages/signals/) | TC39 Signals integration for reactive state sync |

## Documentation

- [Goals & Design Rationale](./docs/GOALS.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [API Design](./docs/API-DESIGN.md)
- [Roadmap](./docs/ROADMAP.md)

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

- **Automatic function proxying:** Callbacks work without wrapping in `proxy()`
- **Nested support:** `nestedProxies` mode allows proxies anywhere in the
  payload
- **Debug mode:** Reports exactly where non-serializable values are
- **Symmetric:** Both ends use the same internal architecture
- **Type-safe:** Better TypeScript inference for what's proxied vs cloned

## License

MIT
