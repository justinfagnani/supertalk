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

With `autoProxy: true`, supertalk treats all values uniformly — functions and
class instances are proxied wherever they appear, including nested inside
returned objects. Comlink doesn't have a built-in auto-proxy mode, though it can
be achieved via custom `transferHandlers`
([tracking issue](https://github.com/GoogleChromeLabs/comlink/issues/662)).

```ts
// Nested functions are automatically proxied
const widget = await remote.createWidget();
await widget.activate(); // Calls back to the exposed side
```

### Composable Services

The root service is just a proxied object like any other — there's nothing
special about it. In the future, we plan to support multiple named services over
a single connection.

### Per-Connection Configuration

All configuration in supertalk is scoped to individual connections via
`expose()` and `wrap()`, rather than using global state. This keeps connections
independent and makes testing straightforward. Configurable options include:

- Auto-proxying behavior (opt-in per connection)
- Custom serializers
- Allowed origins

```ts
// Configuration is scoped to this connection
const remote = wrap<Service>(endpoint, {
  autoProxy: true, // opt-in to automatic nested proxying
});
```

### Debugging Utilities

Debugging `DataCloneError` can be tricky — the browser says "could not be
cloned" without telling you _where_ in your data the problem is.

supertalk provides a `debug` option that traverses your data before sending and
throws a `NonCloneableError` with the exact path to the problematic value:

```ts
// Enable debug mode for helpful error messages
const remote = wrap<Service>(endpoint, {debug: true});

// Now when something fails to clone, you get:
// NonCloneableError: Value of type 'function' at path 'config.onChange'
// cannot be cloned. Enable autoProxy or use proxy() to wrap this value.
```

The `NonCloneableError` includes:

- `valueType`: What kind of value failed (`'function'` or `'class-instance'`)
- `path`: The dot-notation path to the value (e.g., `'config.items[0].callback'`)

**Performance note**: Debug mode adds overhead from traversing your data.
For production, either disable debug mode (the default) or use `autoProxy: true`
which traverses anyway to convert values.

| Mode              | Traverses Data | Error Quality      | Use Case                 |
| ----------------- | -------------- | ------------------ | ------------------------ |
| Default (manual)  | No             | Browser's generic  | Production, simple data  |
| `debug: true`     | Yes            | Path + type info   | Development, debugging   |
| `autoProxy: true` | Yes            | N/A (proxies work) | Production, complex data |

### Future Goals

- **Streams**: Support `ReadableStream`/`WritableStream` across the boundary
- **Signals**: Reactive state synchronization via TC39 Signals
- **Remote servers**: Extend the model to HTTP/WebSocket RPC (speculative)

## Performance

Benchmarks comparing supertalk to Comlink on Node.js worker threads
(MessageChannel). Results vary by environment; these are representative.

| Scenario                | supertalk vs Comlink | autoProxy overhead |
| ----------------------- | -------------------- | ------------------ |
| Simple string echo      | ~1.8x faster         | ~1x (none)         |
| Multiple arguments      | ~2x faster           | ~1x (none)         |
| Large object (~10KB)    | ~1.1x faster         | ~0.5x (traversal)  |
| Large array (10k items) | ~1x (same)           | ~0.6x (traversal)  |
| Callbacks               | ~1x (same)           | ~1x (none)         |

**Notes:**

- "autoProxy overhead" shows the cost of `{autoProxy: true}` vs default mode
- For primitives, autoProxy adds no overhead (no traversal needed)
- For complex objects/arrays, autoProxy traverses to find nested functions, which adds cost
- Run benchmarks yourself: `npm run bench -w @supertalk/core`

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

### Nested Values (with autoProxy)

When `autoProxy: true` is enabled, values nested inside cloned structures
(objects/arrays) are processed recursively:

```ts
// On exposed side (expose with autoProxy)
expose(service, self, {autoProxy: true});

const service = {
  getData() {
    return {
      name: 'example', // cloned (primitive)
      items: [1, 2, 3], // cloned (array of primitives)
      process: (x) => x * 2, // proxied (function)
    };
  },
};

// On wrapped side (wrap with autoProxy)
const remote = wrap<typeof service>(worker, {autoProxy: true});

const data = await remote.getData();
data.name; // 'example' (local copy)
data.items; // [1, 2, 3] (local copy)
await data.process(5); // 10 (calls back to exposed side)
```

**Without `autoProxy`**, nested functions or class instances will cause the
browser's structured clone to fail with `DataCloneError`. Use `debug: true`
during development to get helpful error messages that show exactly which
value failed and where.

### Callbacks

Functions passed as **top-level arguments** are always proxied (no `autoProxy`
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

## Memory Management

Proxied objects are tracked with registries on both sides:

- **Source side**: Holds strong references to objects until the remote releases
  them
- **Consumer side**: Holds weak references; when a proxy is garbage collected,
  the source is notified to release

This prevents memory leaks while ensuring objects stay alive as long as needed.

## License

MIT
