# Supertalk API Design

> **Status**: Exploration — This document explores API options before implementation

## Design Principles

1. **Simple things simple, complex things possible**
2. **Explicit over magic** (but not verbose)
3. **Type safety without ceremony**
4. **Composition over configuration**

---

## Service Definition

### Option A: Decorated Classes (Preferred)

```typescript
import {service, method} from '@supertalk/core';

@service()
class Calculator {
  @method()
  add(a: number, b: number): number {
    return a + b;
  }

  @method()
  async fetchData(url: string): Promise<Data> {
    const response = await fetch(url);
    return response.json();
  }
}
```

**Pros:**

- Familiar OOP pattern
- Clear visual distinction of exposed methods
- Room for method-level options in decorator

**Cons:**

- Requires decorator support
- Runtime metadata needed for some features

### Option B: Interface + Implementation

```typescript
// shared/calculator.ts (shared package)
export interface ICalculator {
  add(a: number, b: number): number;
  fetchData(url: string): Promise<Data>;
}

// server/calculator.ts
import type {ICalculator} from 'shared/calculator';

export class Calculator implements ICalculator {
  add(a: number, b: number): number {
    return a + b;
  }
  // ...
}

// client/main.ts
import type {ICalculator} from 'shared/calculator';

const calc = wrap<ICalculator>(worker);
```

**Pros:**

- No decorators needed
- Clean separation of interface and implementation
- Type-only imports on client

**Cons:**

- Requires separate shared package
- Interface must be kept in sync manually
- No runtime metadata for advanced features

### Option C: Type-Only Import of Class

```typescript
// server/calculator.ts
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}

// client/main.ts
import type {Calculator} from './server/calculator';

const calc = wrap<Calculator>(worker);
```

**Pros:**

- Simplest setup
- No shared package needed
- Types automatically stay in sync

**Cons:**

- Import path to server code (even if type-only)
- Build setup must handle type-only imports correctly
- No runtime metadata

### Recommendation

**Support all three patterns:**

1. **Decorated classes** — Full features, recommended for new projects
2. **Shared interfaces** — For projects that want explicit contracts
3. **Type-only imports** — For quick prototyping or simple cases

---

## Exposing a Service

### Worker Side (Server)

```typescript
import {expose} from '@supertalk/core';

@service()
class Calculator {
  @method()
  add(a: number, b: number): number {
    return a + b;
  }
}

// Expose to parent
expose(new Calculator(), self);
```

### Options for `expose()`

```typescript
expose(service, endpoint, options?: {
  // Allow specific methods only
  methods?: string[];

  // Transform errors before sending
  onError?: (error: Error) => unknown;

  // Middleware for all calls
  middleware?: Middleware[];
});
```

---

## Creating a Client

### Main Thread (Client)

```typescript
import {wrap} from '@supertalk/core';
import type {Calculator} from './worker';

const worker = new Worker('./worker.js', {type: 'module'});
const calc = wrap<Calculator>(worker);

// Fully typed!
const result = await calc.add(1, 2); // Promise<number>
```

### Options for `wrap()`

```typescript
wrap<T>(endpoint, options?: {
  // Timeout for calls
  timeout?: number;

  // Custom serializer
  serializer?: Serializer;

  // AbortSignal for cleanup
  signal?: AbortSignal;
});
```

---

## Decorator Design

### `@service()` Decorator

```typescript
function service(options?: ServiceOptions): ClassDecorator;

interface ServiceOptions {
  // Service name for debugging/logging
  name?: string;

  // Default options for all methods
  defaults?: MethodOptions;
}
```

### `@method()` Decorator

```typescript
function method(options?: MethodOptions): MethodDecorator;

interface MethodOptions {
  // Override method name
  name?: string;

  // Timeout for this method
  timeout?: number;

  // Deep traversal options
  traversal?: 'auto' | 'none' | 'shallow';
}
```

### Field Decorators

#### `@clone()` - Synchronous Property Access

The `@clone()` decorator marks a field as "send once at wrap time" instead of
creating a property proxy that requires `await` on every access.

**Use case**: Signal-valued properties that should be synchronously available:

```typescript
class CounterService {
  @clone() readonly count = new Signal.State(0);
  
  increment() {
    this.count.set(this.count.get() + 1);
  }
}

// Without @clone(): requires await for property access
const signal = await remote.count;  // Promise<RemoteSignal<number>>

// With @clone(): synchronous access
const signal = remote.count;  // RemoteSignal<number> - no await!
signal.get();  // Works immediately with initial value
```

**Semantics**:
- The property's current value is transferred when `wrap()` connects
- The value is cloned/transferred once; the reference is immutable
- If the property is a signal, subsequent updates flow via the signal protocol
- If the property is reassigned on the service, the remote won't see it

**Type impact**: Fields decorated with `@clone()` should not be wrapped in
`Promise<>` in the `Remote<T>` type. This requires decorator metadata to be
accessible to the type system (challenging but possible with sufficiently
advanced TypeScript patterns).

#### `@proxy()` - Force Proxying

The inverse of `@clone()` - mark a field that would normally be cloned as
"create a proxy instead":

```typescript
class Service {
  @proxy() readonly expensiveData = loadHugeDataset();
  
  process(): void {
    // Uses this.expensiveData locally
  }
}

// expensiveData is proxied, not cloned - avoids sending huge data
```

### Parameter Decorators

```typescript
// Mark a method parameter as a proxy (don't clone)
@method()
doWork(@proxy callback: () => void): void;

// Mark return value as a stream
@method()
@stream()
getData(): ReadableStream<Chunk>;

// Mark a property as a signal
@signal()
accessor count: number;
```

---

## Advanced Patterns

### Returning Sub-Services

```typescript
@service()
class Database {
  @method()
  getCollection(name: string): Collection {
    return new Collection(name);
  }
}

@service()
class Collection {
  constructor(private name: string) {}

  @method()
  find(query: Query): Promise<Document[]> {
    // ...
  }
}

// Client usage
const db = wrap<Database>(worker);
const users = await db.getCollection('users'); // Returns proxy to Collection
const docs = await users.find({active: true});
```

### Callbacks

```typescript
@service()
class EventSource {
  @method()
  subscribe(callback: (event: Event) => void): () => void {
    // callback is automatically proxied
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}

// Client
const source = wrap<EventSource>(worker);
const unsubscribe = await source.subscribe((event) => {
  console.log('Event:', event);
});

// Later
await unsubscribe();
```

### Streams

```typescript
@service()
class FileService {
  @method()
  readFile(path: string): ReadableStream<Uint8Array> {
    // Stream is transferred, not proxied
    return new ReadableStream({
      /* ... */
    });
  }
}

// Client
const files = wrap<FileService>(worker);
const stream = await files.readFile('/data.bin');

for await (const chunk of stream) {
  process(chunk);
}
```

### Signals

```typescript
import {Signal} from '@supertalk/core';

@service()
class Counter {
  #count = new Signal.State(0);

  @signal()
  get count(): Signal<number> {
    return this.#count;
  }

  @method()
  increment(): void {
    this.#count.set(this.#count.get() + 1);
  }
}

// Client
const counter = wrap<Counter>(worker);
const countSignal = await counter.count; // Remote signal

// React to changes
effect(() => {
  console.log('Count:', countSignal.get());
});

await counter.increment(); // Triggers effect
```

---

## Transport Abstraction

### Endpoint Interface

```typescript
interface Endpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
}
```

### Built-in Adapters

```typescript
// Workers (built-in, no adapter needed)
expose(service, self);
wrap<T>(new Worker('...'));

// MessagePort
const {port1, port2} = new MessageChannel();
expose(service, port1);
wrap<T>(port2);

// Iframe
expose(service, iframeElement.contentWindow);
wrap<T>(window.parent);

// HTTP (future)
import {httpEndpoint} from '@supertalk/http';
const endpoint = httpEndpoint('https://api.example.com/rpc');
wrap<T>(endpoint);
```

---

## Error Handling

### Error Propagation

Errors thrown in service methods are serialized and re-thrown on the client:

```typescript
@service()
class Validator {
  @method()
  validate(data: unknown): void {
    if (!isValid(data)) {
      throw new ValidationError('Invalid data', {field: 'email'});
    }
  }
}

// Client
try {
  await validator.validate(badData);
} catch (error) {
  // error is a ValidationError with message and properties
}
```

### Custom Error Serialization

```typescript
class ValidationError extends Error {
  constructor(
    message: string,
    public details: object,
  ) {
    super(message);
  }

  // Custom serialization
  static [Symbol.for('supertalk.serialize')](error: ValidationError) {
    return {message: error.message, details: error.details};
  }

  static [Symbol.for('supertalk.deserialize')](data: object) {
    return new ValidationError(data.message, data.details);
  }
}
```

---

## Open Design Questions

1. **Decorator metadata storage**: Where do we store runtime metadata from decorators? WeakMap keyed by class/method?

2. **Implicit vs explicit proxying**: Should functions always be proxied, or require opt-in? Comlink requires `proxy()`, which is error-prone.

3. **Property access**: Should `wrap()` return a proxy that allows property access, or only method calls? Property access is tricky because every access becomes async.

4. **Constructor calls**: Should `new Remote()` work? Comlink supports this but it's complex.

5. **Symbol methods**: Should Symbol-keyed methods be exposed? Probably not by default.

6. **Private methods**: How do we ensure `#private` methods aren't exposed? (They can't be, but what about `_convention` private?)

---

## Next Steps

1. Finalize basic `expose()` / `wrap()` API
2. Implement without decorators first (plain objects)
3. Add decorator support
4. Design proxy lifecycle and memory management
5. Design streaming support
