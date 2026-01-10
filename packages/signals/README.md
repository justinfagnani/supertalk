# @supertalk/signals

TC39 Signals integration for Supertalk. Synchronize reactive state across
workers with automatic batched updates.

## Features

- **Reactive across boundaries:** Signals on the sender side become
  `RemoteSignal`s on the receiver that trigger local effects
- **Synchronous reads:** Initial values are available immediately via `get()`
- **Batched updates:** Multiple signal changes are coalesced into a single
  message
- **Lazy watching:** Source signals are only watched when the receiver observes
  reactively, respecting `[Signal.subtle.watched]` callbacks
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

// Set up reactive observation with a Watcher
const watcher = new Signal.subtle.Watcher(() => {
  // Handle updates
});
const quadrupled = new Signal.Computed(() => count.get() * 4);
watcher.watch(quadrupled);
quadrupled.get(); // Establish the subscription chain

// Mutate on worker side
await remote.increment();
// After microtask, updates propagate (because watcher is watching quadrupled)
console.log(count.get()); // 1
console.log(quadrupled.get()); // 4
```

## API

### `SignalHandler`

Coordinates signal synchronization across a connection. Create one per endpoint.

```ts
const signalHandler = new SignalHandler(options);

// Options:
interface SignalHandlerOptions {
  /**
   * Whether to automatically watch signals when sent (default: false).
   *
   * - false: Lazy watching. Signals are only watched when the receiver
   *   observes them reactively. Respects [Signal.subtle.watched] callbacks.
   *
   * - true: Eager watching. Signals are watched immediately when sent.
   *   Updates always flow regardless of whether receiver is observing.
   */
  autoWatch?: boolean;
}
```

#### Lazy vs Eager Watching

By default (`autoWatch: false`), signals are watched lazily:

```ts
// Sender has a signal with a watched callback
const data = new Signal.State(initialData, {
  [Signal.subtle.watched]: () => startExpensiveDataFetch(),
  [Signal.subtle.unwatched]: () => stopExpensiveDataFetch(),
});

// Sending the signal does NOT trigger the watched callback
const remoteData = await remote.getData();

// Only when something observes the RemoteSignal reactively...
const computed = new Signal.Computed(() => remoteData.get());
// ...does the sender start watching (and the callback fires)
```

Use `autoWatch: true` when you want updates to always flow:

```ts
const signalHandler = new SignalHandler({autoWatch: true});
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
3. When something observes the `RemoteSignal` reactively, a watch message is
   sent to the sender
4. The sender starts monitoring the signal for changes via a `Watcher`
5. When signals change, updates are batched via `queueMicrotask` and sent as a
   single message
6. When the receiver stops observing, an unwatch message is sent and the sender
   stops monitoring

With `autoWatch: true`, steps 3-4 happen immediately when the signal is sent.

## Limitations

- **One-way sync:** Signals flow from sender to receiver. `RemoteSignal`s are
  read-only.
- **Requires handler on both sides:** Both `expose()` and `wrap()` need a
  `SignalHandler` in their handlers array.
- **Lazy watching requires reactive observation:** With the default
  `autoWatch: false`, calling `.get()` outside a reactive context (computed,
  effect, watcher) won't trigger updates. Use `autoWatch: true` if you need
  updates without reactive observation.
