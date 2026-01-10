# @supertalk/signals

TC39 Signals integration for Supertalk. Synchronize reactive state across
workers with automatic batched updates.

## Features

- **Reactive across boundaries:** Signals on the sender side become
  `RemoteSignal`s on the receiver that trigger local effects
- **Synchronous reads:** Initial values are available immediately via `get()`
- **Batched updates:** Multiple signal changes are coalesced into a single
  message
- **Works with `Signal.State` and `Signal.Computed`**

## Installation

```bash
npm install @supertalk/signals signal-polyfill
```

> **Note:** This package requires `signal-polyfill` for the TC39 Signals API.

## Quick Start

**worker.ts** (exposed side):

```ts
import {expose} from '@supertalk/core';
import {Signal} from 'signal-polyfill';
import {SignalHandler} from '@supertalk/signals';

const count = new Signal.State(0);
const doubled = new Signal.Computed(() => count.get() * 2);

const service = {
  getCount: () => count,
  getDoubled: () => doubled,
  increment: () => count.set(count.get() + 1),
};

expose(service, self, {handlers: [new SignalHandler()]});
```

**main.ts** (wrapped side):

```ts
import {wrap} from '@supertalk/core';
import {Signal} from 'signal-polyfill';
import {SignalHandler} from '@supertalk/signals';

const worker = new Worker('./worker.ts');
const remote = await wrap<typeof service>(worker, {
  handlers: [new SignalHandler()],
});

// Get the remote signal (initial value available synchronously)
const count = await remote.getCount();
console.log(count.get()); // 0

// Create local computeds that depend on remote signals
const quadrupled = new Signal.Computed(() => count.get() * 4);
console.log(quadrupled.get()); // 0

// Mutate on worker side
await remote.increment();
// After microtask, updates propagate
console.log(count.get()); // 1
console.log(quadrupled.get()); // 4
```

## API

### `SignalHandler`

Coordinates signal synchronization across a connection. Create one per endpoint.

```ts
// Sending side
expose(service, endpoint, {handlers: [new SignalHandler(endpoint)]});

// Receiving side
const remote = await wrap(endpoint, {handlers: [new SignalHandler(endpoint)]});
```

### `RemoteSignal<T>`

A read-only signal that receives updates from the sender side. You don't create
these directly—they're returned when you access a signal property on a remote
service.

```ts
const count = await remote.getCount(); // RemoteSignal<number>

count.get(); // Read current value (reactive)
count.set(42); // Throws! RemoteSignals are read-only
```

RemoteSignals integrate with the TC39 Signals reactivity system:

```ts
import {Signal} from 'signal-polyfill';

// Local computeds can depend on remote signals
const doubled = new Signal.Computed(() => count.get() * 2);

// Effects track remote signals too
const watcher = new Signal.subtle.Watcher(() => {
  console.log('count changed!');
});
watcher.watch(new Signal.Computed(() => count.get()));
```

## How It Works

1. When a `Signal.State` or `Signal.Computed` is sent across the boundary, the
   `SignalHandler` assigns it an ID and sends the current value
2. The receiver creates a `RemoteSignal` with that initial value
3. On the sender side, a `Watcher` monitors all sent signals for changes
4. When signals change, updates are batched via `queueMicrotask` and sent as a
   single message
5. The receiver updates the corresponding `RemoteSignal`s, triggering any
   dependent computeds or effects

## Limitations

- **One-way sync:** Signals flow from sender to receiver. `RemoteSignal`s are
  read-only.
- **Requires handler on both sides:** Both `expose()` and `wrap()` need a
  `SignalHandler` in their handlers array.
