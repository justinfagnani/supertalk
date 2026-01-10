# Signals Integration Design

> **Status**: Design — Exploration for `@supertalk/signals`

## Overview

TC39 Signals provide reactive state management. Integrating them with Supertalk enables reactive state synchronization across communication boundaries (Workers, iframes, etc.).

**Package**: `@supertalk/signals` (add-on, separate from core)

---

## Core Use Case

Send a signal from one side, observe changes on the other:

```typescript
// Worker (sender)
const count = new Signal.State(0);
expose(
  {
    get count() {
      return count;
    },
    increment() {
      count.set(count.get() + 1);
    },
  },
  self,
  {handlers: [signalHandler]},
);

// Main (receiver)
const remote = wrap<Service>(worker, {handlers: [signalHandler]});
const countSignal = await remote.count; // RemoteSignal<number>

// Initial value available synchronously!
console.log(countSignal.get()); // 0

effect(() => {
  console.log('Count:', countSignal.get()); // Reactive!
});

await remote.increment(); // Effect runs with new value
```

---

## Design Decisions

### 1. Read/Write Semantics

**Decision**: Remote signals are **read-only**.

```typescript
// Main
const count = await remote.count;
count.get(); // ✅ Works
count.set(5); // ❌ Throws
```

**Rationale**:

- Clear ownership model — sender owns the state
- Avoids conflict resolution complexity
- Mirrors how most reactive state works in practice

**Future**: May add opt-in writable mode with explicit last-write-wins semantics. If enabled, the sender should stop writing to avoid conflicts:

```typescript
// Future API (not implemented)
return signal(count, {writable: true});
// Warning: sender should not write after sending with writable: true
```

---

### 2. Computed Signals

**Decision**: Computed signals are treated as **read-only state** from the receiver's perspective.

```typescript
// Worker
const count = new Signal.State(0);
const doubled = new Signal.Computed(() => count.get() * 2);

expose(
  {
    get doubled() {
      return doubled;
    },
  },
  self,
);
```

```typescript
// Main
const doubled = await remote.doubled;
doubled.get(); // Returns current computed value
// Updates when underlying state changes on sender
```

**Rationale**: The sender computes, the receiver observes. No need to serialize computation functions or track dependencies across boundaries.

---

### 3. Watching and Updates

**Decision**: Use a **single watcher** on the sender side for all sent signals. When any watched signal changes, collect all dirty signals and send a batch update.

#### How It Works

1. When a signal is sent across the wire, sender registers it and starts watching via a single `Signal.subtle.Watcher`
2. Initial value is sent immediately (enables synchronous `get()` on receiver)
3. When the watcher callback fires, use `watcher.getPending()` to get all changed signals
4. Send batch update with all changed values

```typescript
// Sender side (internal)
const watcher = new Signal.subtle.Watcher(() => {
  // Get all pending (dirty) signals
  const pending = watcher.getPending();

  // Collect updates for signals we've sent
  const updates = [];
  for (const signal of pending) {
    const signalId = sentSignals.get(signal);
    if (signalId !== undefined) {
      updates.push({signalId, value: toWire(signal.get())});
    }
  }

  // Batch send
  if (updates.length > 0) {
    queueMicrotask(() => sendBatch(updates));
  }
});

// When sending a signal
function registerSignal(signal: Signal.State<T> | Signal.Computed<T>) {
  const signalId = nextId++;
  sentSignals.set(signal, signalId);
  watcher.watch(signal);
  return signalId;
}
```

#### No Subscribe Message Needed

Since we watch every sent signal, there's no need for explicit subscribe/unsubscribe messages from the receiver.

**Memory management** reuses the existing proxy machinery:

- Remote signals use the same `WeakRef`/`FinalizationRegistry` pattern as proxies
- When the remote signal is GC'd, a release message is sent
- Sender unwatches and releases its reference

This is simpler than a subscribe model and matches how proxies already work.

---

### 4. Value Serialization

**Decision**: Signal values follow **normal serialization rules** (same as any other value).

```typescript
// Worker
const user = new Signal.State({
  name: 'Alice',
  onClick: () => console.log('clicked'), // Function!
});
```

- Without `nestedProxies`: Functions throw serialization error
- With `nestedProxies`: Functions are proxied
- With `debug`: `NonCloneableError` with path

**Error handling**: Serialization errors **throw** on the sender side. The sender needs to know if their signal value can't be serialized.

---

### 5. Batching

**Decision**: **Automatic batching** via microtask. Only batch updates, no single-signal message.

```typescript
// Worker
const a = new Signal.State(0);
const b = new Signal.State(0);
const c = new Signal.State(0);

function updateAll() {
  a.set(1);
  b.set(2);
  c.set(3);
  // Single batch message sent at end of microtask
}
```

Since we use a single watcher with `getPending()`, batching is natural:

```typescript
// Watcher callback (simplified)
const watcher = new Signal.subtle.Watcher(() => {
  queueMicrotask(() => {
    const pending = watcher.getPending();
    const updates = collectUpdates(pending);
    if (updates.length > 0) {
      endpoint.postMessage({type: 'signal:batch', updates});
    }
  });
});
```

**Wire protocol** — only batch messages:

```typescript
interface SignalBatchUpdate {
  type: 'signal:batch';
  updates: Array<{signalId: number; value: WireValue}>;
}
```

---

### 6. Signal Subgraphs

**Question**: What if we send multiple related signals?

```typescript
// Worker
const firstName = new Signal.State('Alice');
const lastName = new Signal.State('Smith');
const fullName = new Signal.Computed(
  () => `${firstName.get()} ${lastName.get()}`,
);

expose(
  {
    get user() {
      return {firstName, lastName, fullName};
    },
  },
  self,
);
```

**Decision**: Each signal is independent. The single-watcher + `getPending()` approach naturally handles this:

- When `firstName.set('Bob')` is called
- Both `firstName` and `fullName` become dirty
- `getPending()` returns both
- Single batch update: `[{ firstName: 'Bob' }, { fullName: 'Bob Smith' }]`

No explicit graph tracking needed — TC39 Signals' dirty tracking does the work.

---

### 7. Signal Collections (`signal-utils`)

**Question**: Can we support `SignalArray`, `SignalMap`, signal-backed class fields?

```typescript
import {SignalArray} from 'signal-utils/array';

const items = new SignalArray([1, 2, 3]);
items.push(4); // Reactive
```

#### Approach A: Handler Per Collection Type

Write handlers for each collection:

```typescript
const signalArrayHandler: Handler<SignalArray<unknown>> = {
  wireType: 'signal:array',
  canHandle: (v) => v instanceof SignalArray,
  // ...
};
```

**Challenges**:

- Many collection types to support
- Each has different mutation semantics
- Keeping proxy and original in sync is complex

#### Approach B: Proxy the Collection

Treat `SignalArray` like any other class instance — proxy it. Method calls are remote.

```typescript
// Receiver gets a proxy
const items = await remote.items; // Proxy<SignalArray>
await items.push(4); // Remote call
items.length; // Remote property access
```

**Pros**: Works automatically, no special handlers needed.
**Cons**: Every operation is async/remote.

#### Approach C: Reactive Proxy + Periodic Sync

Proxy the collection, but also subscribe to a "snapshot signal" that updates on changes.

```typescript
// Internal: sender creates a signal from the array
const itemsSignal = computed(() => [...items]);

// Receiver gets both:
// - Proxy for mutations
// - Signal for reactive reads
```

#### Approach D: Our Own Collections

Create `@supertalk/signals` collections designed for remote sync:

```typescript
import {RemoteArray, RemoteMap} from '@supertalk/signals';

// Designed from the ground up for wire sync
const items = new RemoteArray([1, 2, 3]);
```

**Recommendation**: Start with **Approach B (proxy)**. It works today with no extra code. Consider Approach C or D later if performance/DX demands it.

---

### 8. Signal-Backed Class Fields

`signal-utils` provides decorators for signal-backed fields:

```typescript
import {signal} from 'signal-utils';

class Counter {
  @signal accessor count = 0;
}
```

#### How It Works Today

With `nestedProxies`, class instances are proxied. The `@signal` fields are just properties that return signal values.

```typescript
// If we expose a Counter instance
const counter = await remote.counter;
counter.count; // Returns the current value (proxied property access)
counter.count = 5; // Proxied setter
```

But we lose reactivity — there's no way to subscribe to `count` changes.

#### Better Support

If we detect signal-backed properties, we could:

1. Send the underlying signal instead of just the value
2. Create a proxy where property access returns the remote signal

```typescript
const counter = await remote.counter;
const countSignal = counter.$count; // Access underlying signal
effect(() => console.log(countSignal.get()));
```

**Or** make the property itself reactive:

```typescript
// Magic proxy where property access is reactive
watch(counter, 'count', (newValue) => { ... });
```

**Recommendation**: Defer this. The proxy approach works; optimize later if needed.

---

## Wire Protocol

### Message Types

Only one message type needed:

```typescript
interface SignalBatchUpdate {
  type: 'signal:batch';
  updates: Array<{signalId: number; value: WireValue}>;
}
```

No subscribe/unsubscribe messages — memory management reuses proxy release messages.

### Signal Wire Representation

When a signal is serialized:

```typescript
interface WireSignal {
  [WIRE_TYPE]: 'signal';
  signalId: number;
  value: WireValue; // Initial value, sent immediately
}
```

### Signal Lifecycle

1. **Send**: Signal is detected by handler, registered with watcher, `signalId` assigned
2. **Wire**: `WireSignal` sent with initial value
3. **Receive**: Handler creates `RemoteSignal` with initial value, registers for updates
4. **Updates**: Watcher fires → `getPending()` → batch update sent
5. **Cleanup**: Remote signal GC'd → release message → sender unwatches

### Memory Management

Signals follow the **same pattern** as proxies for memory management, but with signal-specific cleanup on the sender side.

#### What's Shared (Pattern)

Both proxies and remote signals use WeakRef + FinalizationRegistry on the receiver side:

```typescript
// Receiver side — shared infrastructure (conceptual)
class RemoteRefRegistry {
  #release: (id: number) => void;
  #refs = new Map<number, WeakRef<object>>();
  #registry = new FinalizationRegistry((id: number) => {
    this.#refs.delete(id);
    this.#release(id); // Send release message
  });

  register(id: number, ref: object) {
    this.#refs.set(id, new WeakRef(ref));
    this.#registry.register(ref, id);
  }
}

// Both proxies and RemoteSignals registered the same way
registry.register(proxyId, proxyObject);
registry.register(signalId, remoteSignal);
```

#### What's Different (Cleanup)

The sender-side cleanup differs:

```typescript
// Sender side — handles release message
function handleRelease(id: number) {
  // Check if it's a signal
  const signal = sentSignals.get(id);
  if (signal) {
    watcher.unwatch(signal); // Signal-specific: stop watching
    sentSignals.delete(id);
    return;
  }

  // Otherwise it's a proxy
  localObjects.delete(id);
}
```

#### ID Space Options

**Option A: Shared ID space** — Proxies and signals share one counter. Release message just has `id`.

**Option B: Separate ID spaces** — Each has its own counter. Release message includes type:

```typescript
interface ReleaseMessage {
  type: 'release';
  refType: 'proxy' | 'signal';
  id: number;
}
```

**Recommendation**: Shared ID space is simpler. The sender already needs to look up the ID to find the object anyway.

---

## Implementation Phases

### Phase 1: Basic State Signals

- [ ] `Signal.State` detection and handler
- [ ] Read-only `RemoteSignal` class
- [ ] Single watcher for all sent signals
- [ ] Initial value sent immediately
- [ ] Batch update on watcher callback
- [ ] Basic tests

### Phase 2: Computed Signals

- [ ] `Signal.Computed` detection
- [ ] Same wire representation as state (read-only)
- [ ] Tests with computed signals

### Phase 3: Memory Management

- [x] Reuse proxy release message for cleanup
- [x] Unwatch on release
- [x] Tests for cleanup

### Future

#### Fused Signal Updates (Planned)

Piggyback signal updates on response messages for causal consistency:

```typescript
// Problem: race condition
await remote.increment(); // Returns before signal:batch arrives
console.log(count.get()); // Might still be 0!

// Solution: include updates in response
// Response: { result: void, signalUpdates: [[signalId, 1]] }
await remote.increment();
console.log(count.get()); // Guaranteed to be 1
```

#### Collection Support (Planned)

Sync `signal-utils` collections like `SignalArray`:

```typescript
const items = new SignalArray([1, 2, 3]);
// Receiver gets synchronized copy
const remoteItems = await remote.items;
remoteItems.at(0); // Reactive!
```

Options: full sync (simple), operation sync (efficient), or diff sync.
Likely in separate `@supertalk/signal-utils` package.

#### Other Future Items

- [ ] Opt-in writable signals (last-write-wins, sender stops writing)
- [ ] Error handling in update deserialization
- [ ] Reconnection handling (re-subscribe to watched signals)

---

## Open Questions

1. **Polyfill choice**: Which signals polyfill to use for now? (`signal-polyfill`?)

2. **Ordering guarantees**: Are updates guaranteed to arrive in order? (Yes for postMessage, may need sequence numbers for other transports)

3. **Computed evaluation**: When does `getPending()` trigger computed re-evaluation? Need to verify TC39 semantics.

---

## Summary of Decisions

| Question               | Decision                                           |
| ---------------------- | -------------------------------------------------- |
| Read/write on receiver | **Read-only** (throws on write)                    |
| Future writable mode   | **Last-write-wins**, sender stops writing          |
| Computed signals       | **Read-only state** (sender computes)              |
| Initial value          | **Sent immediately** (sync `get()` on receiver)    |
| Serialization errors   | **Throw** on sender side                           |
| Watching               | **Single watcher** for all sent signals            |
| Batching               | **Automatic** via `getPending()` + microtask       |
| Wire messages          | **Batch only** (no single-signal update)           |
| Subscribe/unsubscribe  | **Not needed** — reuse proxy release               |
| Value serialization    | **Normal rules** (follows `nestedProxies` setting) |
| Collections            | **Proxy approach** (works today)                   |
| Signal-backed fields   | **Defer** (proxy works for now)                    |
| Framework adapters     | **Not needed** (already exist for raw signals)     |
