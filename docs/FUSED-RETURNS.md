# Fused Function Returns and Signal Updates

Design document for synchronizing signal updates with function return messages.

## Problem Statement

When a client calls a remote function that mutates signals, the signal updates
arrive in a separate message after the function returns:

```ts
const service = await wrap<MyService>(worker);
const count = await service.getCount();
count.get(); // 0

await service.increment();
// Function has returned, but signal update is still in flight
count.get(); // Still 0! Update arrives in next message

// ...after microtask/message event...
count.get(); // Now 1
```

**Goal:** Fuse signal updates with function return messages so signals are
guaranteed to be updated when the awaited call resolves:

```ts
await service.increment();
count.get(); // 1 - no waiting for a separate signal update message
```

## Current Architecture

### Message Flow

1. **Call message** → function executes on expose side
2. **Return message** → result sent back to wrap side
3. **Handler message** (`signal:batch`) → signal updates sent separately

### Signal Watcher Timing

When signals are mutated:

1. Watcher `notify` callback fires **synchronously**
2. Signals cannot be read _during_ the callback
3. Signals can be read **immediately after** the callback returns
4. Current implementation schedules a microtask via `queueMicrotask`

**Key insight:** We don't need the microtask. After the function returns, we're
past the notify callback and can read signals synchronously:

```ts
// In #handleCall
result = await fn(...args); // Signals mutate, watcher notify fires
// RIGHT HERE - notify has returned, we can read signals synchronously
const updates = signalHandler.collectPendingUpdates();
// Send return + updates together in one message
```

### Timing Analysis

For **sync functions**: Everything happens in a single task with no delays.

For **async functions**: We're already in a microtask when the await resolves,
so no additional delay.

Even if we needed one extra microtask, the overall round-trip involves multiple
task boundaries (postMessage dispatch, message event handlers), so one microtask
is negligible.

## Design Options

### Option A: Extensible Payload on Return Messages

Add an optional `ext` field to `ReturnMessage` for handler extensions:

```ts
interface ReturnMessage {
  type: 'return';
  id: number;
  value: WireValue;
  ext?: Record<string, WireValue>; // keyed by handler wireType
}
```

**New Handler hooks:**

```ts
interface Handler {
  // ... existing ...

  /**
   * Collect data to include in an outgoing return message.
   * Called after function execution completes, before sending return.
   * Return undefined to contribute nothing.
   */
  collectReturnData?(): unknown;

  /**
   * Process extension data from an incoming return message.
   * Called after return value is deserialized but before resolving the call.
   */
  processReturnData?(data: unknown, ctx: FromWireContext): void;
}
```

**Pros:**

- Minimal wire overhead when no handlers contribute
- General extension point - other handlers could use it
- Clean separation of concerns

**Cons:**

- Adds ~150-200 bytes minified (~80-120 bytes brotli) to core
- New handler hooks to understand

### Option B: Batched Message Queue

Make all messages conceptually batches:

```ts
interface MessageBatch {
  messages: Message[];
}
```

Messages queue up and flush together on certain triggers.

**Pros:**

- General solution for any message combination
- Could improve performance for rapid-fire operations

**Cons:**

- Larger architectural change
- Most messages don't benefit from batching
- Adds latency to simple operations (must wait for batch flush)

### Option C: Synchronous Signal Polling

Instead of using the watcher, iterate through all sent signals at return time
and check which changed:

```ts
#collectUpdates(): SignalBatchUpdate | undefined {
  const updates = [];
  for (const [id, signal] of this.#sentSignals) {
    // Check if value changed since last sync...
  }
  return updates.length ? { type: 'signal:batch', updates } : undefined;
}
```

**Pros:**

- Works without watcher infrastructure

**Cons:**

- Expensive with large signal graphs
- Need to track "last sent value" for comparison
- Doesn't integrate with existing watcher-based change detection

### Option D: Only Support with autoWatch

Limit fused updates to `autoWatch: true` mode only.

**Rationale:**

- With `autoWatch: false` (lazy), you explicitly chose lazy behavior
- With `autoWatch: true` (eager), you want updates to always flow
- Fusing with returns is a natural extension of eager mode

**Pros:**

- Keeps lazy watching semantics completely unchanged
- No need to handle unwatched signals
- Clear mental model

**Cons:**

- Users who want fused updates must opt into eager watching
- Can't have lazy watching + fused updates

## Recommended Design: Option A + D Hybrid

Combine extensible return payloads (Option A) with autoWatch-only behavior
(Option D).

### Wire Protocol Change

```ts
interface ReturnMessage {
  type: 'return';
  id: number;
  value: WireValue;
  ext?: Record<string, WireValue>; // handler extensions, keyed by wireType
}
```

The `ext` field is omitted when no handlers contribute data (no wire overhead
for the common case).

### Handler Interface Additions

```ts
interface Handler {
  /**
   * Collect data to include in an outgoing return message.
   * Called after function execution completes, before sending return.
   * Return undefined to contribute nothing.
   */
  collectReturnData?(): unknown;

  /**
   * Process extension data from an incoming return message.
   * Called after return value is deserialized but before resolving the call.
   */
  processReturnData?(data: unknown, ctx: FromWireContext): void;
}
```

### Core Library Changes

**In `#handleCall`, before sending return:**

```ts
// Collect handler extensions
let ext: Record<string, WireValue> | undefined;
for (const handler of this.#handlers) {
  if (handler.collectReturnData) {
    const data = handler.collectReturnData();
    if (data !== undefined) {
      ext ??= {};
      ext[handler.wireType] = this.#toWire(data, '', transfers);
    }
  }
}

this.#endpoint.postMessage(
  {
    type: 'return',
    id,
    value: wire,
    ...(ext && {ext}),
  },
  transfers,
);
```

**In return message handler:**

```ts
case 'return': {
  // Process handler extensions first (before resolving)
  if (message.ext) {
    for (const [wireType, data] of Object.entries(message.ext)) {
      const handler = this.#handlersByWireType.get(wireType);
      handler?.processReturnData?.(
        this.#fromWire(data),
        this.#createFromWireContext()
      );
    }
  }
  // Then resolve the call
  call.resolve(this.#fromWire(message.value));
}
```

### SignalHandler Changes

```ts
collectReturnData(): SignalBatchUpdate | undefined {
  // Only fuse updates in autoWatch mode
  if (!this.#autoWatch) return undefined;

  const pending = this.#watcher?.getPending() ?? [];
  if (pending.length === 0) return undefined;

  const updates: Array<{signalId: number; value: unknown}> = [];
  for (const wrapper of pending) {
    for (const [signalId, w] of this.#signalWrappers) {
      if (w === wrapper) {
        updates.push({ signalId, value: wrapper.get() });
        break;
      }
    }
  }

  // Re-watch to continue tracking future changes
  this.#watcher?.watch();

  return updates.length > 0 ? { type: 'signal:batch', updates } : undefined;
}

processReturnData(data: unknown, ctx: FromWireContext): void {
  if (isSignalBatchUpdate(data)) {
    this.#handleBatchUpdate(data);
  }
}
```

## Size Impact

Estimated additions to `@supertalk/core`:

| Component     | Minified | Brotli  |
| ------------- | -------- | ------- |
| Type changes  | 0 bytes  | 0 bytes |
| Runtime hooks | ~150-200 | ~80-120 |

Approximately **4-6%** increase on the ~2KB brotli target.

## Open Questions

### 1. Should the handshake return support extensions?

The `expose()` side sends a return message with `id: HANDSHAKE_ID` when the
service is ready. If the service constructor mutates signals, should those fuse
with the handshake?

**Recommendation:** Yes, for consistency. The same code path handles both.

### 2. Should `collectReturnData` receive call context?

Currently proposed as parameterless. Could pass info like target ID, method
name, etc.

**Recommendation:** No - keep it simple. Handlers can track their own state if
needed.

### 3. Future: Fused updates with lazy watching?

Could we support fused updates even with `autoWatch: false`? This would require:

- Tracking which signals a function _might_ mutate, OR
- Iterating all sent signals checking for changes (expensive), OR
- Some decorator/annotation on functions that declare their signal dependencies

**Recommendation:** Defer. The autoWatch-only approach covers the main use case.
Users who want guaranteed updates should opt into eager watching.

## Workaround Without This Feature

Users can achieve similar behavior today by having mutating functions return the
signals they modified:

```ts
// Service implementation
const service = {
  increment(): Signal.State<number> {
    count.set(count.get() + 1);
    return count; // Return the signal - gets re-serialized with new value
  },
};

// Client
const updatedCount = await service.increment();
// The returned signal has the new value, and if it's the same signal ID,
// the SignalHandler updates the existing RemoteSignal
```

This works because `toWire` always sends the current signal value. However, it
requires explicit return types and doesn't update signals that weren't returned.

## Implementation Phases

### Phase 1: Core Extension Point

1. Add `ext` field to `ReturnMessage` type
2. Add `collectReturnData` and `processReturnData` to Handler interface
3. Implement collection/dispatch in Connection class
4. Add tests for the extension mechanism

### Phase 2: SignalHandler Integration

1. Implement `collectReturnData` (autoWatch only)
2. Implement `processReturnData`
3. Add tests verifying fused updates
4. Update documentation

### Phase 3: Documentation

1. Update README examples showing the guarantee
2. Document the autoWatch requirement for fused updates
3. Add migration guide if changing defaults
