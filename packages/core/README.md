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
be achieved via custom `transferHandlers` ([tracking
issue](https://github.com/GoogleChromeLabs/comlink/issues/662)).

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
- `path`: The dot-notation path to the value (e.g.,
  `'config.items[0].callback'`)

**Performance note**: Debug mode adds overhead from traversing your data. For
production, either disable debug mode (the default) or use `autoProxy: true`
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
- For complex objects/arrays, autoProxy traverses to find nested functions,
  which adds cost
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
during development to get helpful error messages that show exactly which value
failed and where.

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

## TypeScript Types

supertalk provides utility types to correctly type remote service interfaces.
All functions become async across the communication boundary, and returned
objects may be proxied or cloned depending on their type.

### Manual vs Auto-Proxy Modes

The type you use depends on which mode you're operating in:

| Mode                           | Type                 | What gets transformed                  |
| ------------------------------ | -------------------- | -------------------------------------- |
| Manual (default)               | `Remote<T>`          | Top-level returns only                 |
| Auto-proxy (`autoProxy: true`) | `RemoteAutoProxy<T>` | All nested functions & class instances |

**Manual mode** is the default. Only the immediate return values of service
methods are processed — nested functions inside returned objects will fail with
`DataCloneError` unless you explicitly handle them.

**Auto-proxy mode** recursively traverses all values, converting nested
functions and class instances to proxies automatically.

The `wrap()` function automatically infers the correct return type based on
the `autoProxy` option:

```ts
// Manual mode (default) — returns Remote<T>
const remote = wrap<MyService>(worker);

// Auto-proxy mode — returns RemoteAutoProxy<T>
const remote = wrap<MyService>(worker, {autoProxy: true});
```

### `Remote<T, ProxiedTypes?, ExcludedTypes?>`

The primary type for **manual mode**. Transforms top-level service methods to
return `Promise`s. Return values are transformed via `Remoted<T>`, which makes
functions async but does NOT recurse into nested objects.

```ts
import {wrap} from '@supertalk/core';

interface MyService {
  add(a: number, b: number): number;
  createWidget(): Widget;
}

const remote = wrap<MyService>(worker);
const result = await remote.add(1, 2); // Promise<number>
```

**What it does:**

- Top-level methods become async: `add(a, b): number` → `add(a, b):
Promise<number>`
- Return values are transformed via `Remoted<T>` (top-level functions become
  async)
- Non-function properties are excluded (not callable remotely)

### `RemoteAutoProxy<T, ProxiedTypes?, ExcludedTypes?>`

The type for **auto-proxy mode**. Like `Remote<T>`, but nested functions
anywhere in return values are also transformed to async.

```ts
import {wrap} from '@supertalk/core';

interface MyService {
  getData(): {value: number; process: (x: number) => number};
}

const remote = wrap<MyService>(worker, {autoProxy: true});

const data = await remote.getData();
data.value; // number (cloned)
await data.process(5); // Promise<number> (proxied function)
```

**Difference from `Remote<T>`:**

- Arguments accept both original and remoted versions (for round-trip proxies)
- Otherwise identical transformation

### `Remoted<T, ProxiedTypes?, ExcludedTypes?>`

Recursively transforms a type to make all functions async. Used internally by
`Remote<T>` and `RemoteAutoProxy<T>`, but can be used directly when you need to
type a returned value.

```ts
import type {Remoted} from '@supertalk/core';

class Counter {
  count = 0;
  increment(): number {
    return ++this.count;
  }
}

// Remoted<Counter> transforms methods to async:
// { count: number; increment: () => Promise<number> }
```

**Transformation rules:**

| Input Type      | Output Type                     |
| --------------- | ------------------------------- |
| Primitives      | Unchanged                       |
| `() => T`       | `() => Promise<T>`              |
| `object`        | `{ [K]: Remoted<T[K]> }`        |
| `Array<T>`      | `Array<Remoted<T>>`             |
| `ProxiedTypes`  | `Proxied<T>` (all API is async) |
| `ExcludedTypes` | Recurse (functions only async)  |

### `Proxied<T>`

Transforms ALL properties to async, not just functions. Use this when you know
you're working with a proxied class instance and need to await property access.

```ts
import type {Proxied} from '@supertalk/core';

class Counter {
  name: string;
  count = 0;
  increment(): number {
    return ++this.count;
  }
}

// Proxied<Counter>:
// {
//   name: Promise<string>;
//   count: Promise<number>;
//   increment: () => Promise<number>;
// }

const counter = (await remote.createCounter()) as Proxied<Counter>;
await counter.name; // Property access is async
await counter.increment(); // Method call is async
```

**When to use `Proxied<T>`:**

- When you access properties (not just methods) on proxied class instances
- By default, `Remoted<T>` only makes functions async, not properties
- Use `ProxiedTypes` parameter on `Remote<T>` to automatically apply this

### `ProxiedTypes` and `ExcludedTypes` Parameters

These optional type parameters let you declare which types are proxied at
runtime, improving the accuracy of remote object types without requiring casts
at the use sites.

```ts
class Counter {
  name: string;
  increment(): number { ... }
}

interface MyService {
  createCounter(): Counter;
  getData(): { value: number };
}

// Declare Counter as a proxied type
type MyRemote = Remote<MyService, [Counter]>;

const counter = await remote.createCounter();
await counter.name;       // Promise<string> ✓
await counter.increment(); // Promise<number> ✓

const data = await remote.getData();
data.value; // number ✓ (plain object, not proxied)
```

### Sharp Edges: Structural Typing

TypeScript uses **structural typing**, meaning it cannot distinguish between a
class instance and a plain object with the same shape. This creates potential
type mismatches:

```ts
interface WidgetData {
  name: string;
  active: boolean;
}

class Widget {
  name: string;
  active: boolean;
  activate(): void {}
}

interface MyService {
  createWidget(): Widget; // Returns class instance (proxied)
  getWidgetData(): WidgetData; // Returns plain object (cloned)
}

// Problem: WidgetData structurally matches Widget!
type MyRemote = Remote<MyService, [Widget]>;

// getWidgetData() returns a CLONED plain object at runtime,
// but TypeScript thinks it's Proxied<Widget> due to structural match
const data = await remote.getWidgetData();
await data.name; // Type says Promise<string>, but it's actually string!
```

**Solutions:**

1. **Use `ExcludedTypes`** to carve out exceptions:

   ```ts
   type MyRemote = Remote<MyService, [Widget], [WidgetData]>;
   // Now WidgetData is excluded from Proxied treatment
   ```

2. **Use distinct types** — add a discriminant property or use branded types:

   ```ts
   class Widget {
     readonly __brand = 'Widget' as const;
     // ...
   }
   ```

3. **Only list concrete classes** — avoid listing interfaces that plain objects
   might match

### Limitations

**Properties aren't accessible by default:**

`Remote<T>` only exposes methods, not properties. For property access on a
proxied object, cast to `Proxied<T>` or use `ProxiedTypes`.

**Getters look like properties:**

Class getters appear as properties from the proxy's perspective. They're
accessed asynchronously like any other property.

**`wrap()` infers return type from literal options:**

When you pass `{ autoProxy: true }` as a literal, `wrap()` returns
`RemoteAutoProxy<T>`. When you omit options or pass `{ autoProxy: false }`,
it returns `Remote<T>`.

```ts
// Type is inferred correctly from literal options:
const remote1 = wrap<MyService>(worker); // Remote<MyService>
const remote2 = wrap<MyService>(worker, {autoProxy: true}); // RemoteAutoProxy<MyService>
```

However, if you pass a variable with type `Options`, TypeScript can't know
the literal value, so it defaults to `Remote<T>`:

```ts
const opts: Options = {autoProxy: true};
const remote = wrap<MyService>(worker, opts); // Remote<T>, not RemoteAutoProxy<T>
// Cast if needed:
const remote = wrap<MyService>(worker, opts) as RemoteAutoProxy<MyService>;
```

**`ProxiedTypes` requires casting:**

The `wrap()` function doesn't have a way to specify `ProxiedTypes`. Cast the
result if you need it:

```ts
const remote = wrap<MyService>(worker) as Remote<MyService, [Counter]>;
```

## License

MIT
