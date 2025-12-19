# @supertalk/core

A type-safe, unified client/server communication library for:

- Web Workers
- Iframes
- Node.js worker threads
- Browser-to-server RPC (HTTP/WebSocket)

## Installation

```bash
npm install @supertalk/core
```

## Motivation

supertalk is inspired by [Comlink](https://github.com/GoogleChromeLabs/comlink),
but explores a few different design choices:

### Nested Object Support

Comlink proxies the top-level object but doesn't automatically proxy nested
objects returned from methods. supertalk treats all values uniformly — functions
and class instances are proxied wherever they appear.

```ts
// Nested functions are automatically proxied
const widget = await remote.createWidget();
await widget.activate(); // Calls back to the exposed side
```

### Composable Services

The root service is just a proxied object like any other — there's nothing
special about it. In the future, we plan to support multiple named services over
a single connection.

### Future Goals

- **Streams**: Support `ReadableStream`/`WritableStream` across the boundary
- **Signals**: Reactive state synchronization via TC39 Signals
- **Remote servers**: Extend the model to HTTP/WebSocket RPC (speculative)

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

## Value Handling: Proxied vs Cloned

When values cross the communication boundary, supertalk decides whether to
**clone** (copy the value) or **proxy** (create a remote reference).

| Value Type                                                      | Behavior    | Reason                                          |
| --------------------------------------------------------------- | ----------- | ----------------------------------------------- |
| Primitives (`string`, `number`, `boolean`, `null`, `undefined`) | Cloned      | Immutable, safe to copy                         |
| Plain objects (`{}`, `Object.create(null)`)                     | Cloned      | Usually data containers without methods         |
| Arrays                                                          | Cloned      | Data containers, elements processed recursively |
| Functions                                                       | **Proxied** | Must execute in original context                |
| Class instances                                                 | **Proxied** | Have identity, methods, internal state          |
| Objects with custom prototype                                   | **Proxied** | Likely have methods or special behavior         |

### How Plain Objects Are Detected

An object is considered "plain" if its prototype is either:

- `null` (created via `Object.create(null)`)
- `Object.prototype` (created via `{}` or `new Object()`)

Everything else (class instances, objects with custom prototypes) is proxied.

### Nested Values

Values nested inside cloned structures (objects/arrays) are processed
recursively:

```ts
// On exposed side
const service = {
  getData() {
    return {
      name: 'example', // cloned (primitive)
      items: [1, 2, 3], // cloned (array of primitives)
      process: (x) => x * 2, // proxied (function)
    };
  },
};

// On wrapped side
const data = await remote.getData();
data.name; // 'example' (local copy)
data.items; // [1, 2, 3] (local copy)
await data.process(5); // 10 (calls back to exposed side)
```

### Callbacks

Functions passed as arguments are automatically proxied:

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

## Memory Management

Proxied objects are tracked with registries on both sides:

- **Source side**: Holds strong references to objects until the remote releases
  them
- **Consumer side**: Holds weak references; when a proxy is garbage collected,
  the source is notified to release

This prevents memory leaks while ensuring objects stay alive as long as needed.

## License

MIT
