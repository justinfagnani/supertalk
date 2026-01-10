import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {Signal} from 'signal-polyfill';
import {RemoteSignal} from '../../index.js';
import {
  setupSignalService,
  waitMicrotasks,
  waitForMessages,
} from './test-utils.js';

void suite('@supertalk/signals', () => {
  void suite('RemoteSignal', () => {
    void test('stores initial value and returns it via get()', () => {
      const remote = new RemoteSignal(1, 42);
      assert.strictEqual(remote.get(), 42);
    });

    void test('throws on set()', () => {
      const remote = new RemoteSignal(1, 42);
      assert.throws(() => remote.set(100), /read-only/i);
    });

    void test('updates value via _update()', () => {
      const remote = new RemoteSignal(1, 42);
      remote._update(100);
      assert.strictEqual(remote.get(), 100);
    });

    void test('exposes signalId', () => {
      const remote = new RemoteSignal(123, 'test');
      assert.strictEqual(remote.signalId, 123);
    });
  });

  void suite('Signal transfer', () => {
    void test('Signal.State is transferred with initial value', async () => {
      const count = new Signal.State(42);

      using ctx = await setupSignalService({
        get count() {
          return count;
        },
      });

      const remoteCount = await ctx.remote.count;

      // Should be a RemoteSignal
      assert.ok(remoteCount instanceof RemoteSignal);

      // Should have the initial value
      assert.strictEqual(remoteCount.get(), 42);
    });

    void test('Signal.State initial value is available synchronously', async () => {
      const name = new Signal.State('Alice');

      using ctx = await setupSignalService({
        get name() {
          return name;
        },
      });

      const remoteName = await ctx.remote.name;

      // Synchronous access works
      const value = remoteName.get();
      assert.strictEqual(value, 'Alice');
    });

    void test('Signal.Computed is transferred with computed value', async () => {
      const count = new Signal.State(5);
      const doubled = new Signal.Computed(() => count.get() * 2);

      using ctx = await setupSignalService({
        get doubled() {
          return doubled;
        },
      });

      const remoteDoubled = await ctx.remote.doubled;

      assert.ok(remoteDoubled instanceof RemoteSignal);
      assert.strictEqual(remoteDoubled.get(), 10);
    });

    void test('multiple signals can be transferred', async () => {
      const a = new Signal.State(1);
      const b = new Signal.State(2);

      using ctx = await setupSignalService({
        get a() {
          return a;
        },
        get b() {
          return b;
        },
      });

      const [remoteA, remoteB] = await Promise.all([
        ctx.remote.a,
        ctx.remote.b,
      ]);

      assert.strictEqual(remoteA.get(), 1);
      assert.strictEqual(remoteB.get(), 2);
    });
  });

  void suite('Signal updates', () => {
    void test('watcher tracks State via Computed wrapper', () => {
      // The watcher only tracks Computed signals, not State directly.
      // To watch a State signal, wrap it in a Computed.
      const count = new Signal.State(0);
      let callbackCount = 0;

      const watcher = new Signal.subtle.Watcher(() => {
        callbackCount++;
      });

      // Create a wrapper Computed that reads the State
      const wrapper = new Signal.Computed(() => count.get());
      watcher.watch(wrapper);

      // Read the wrapper to establish the subscription
      wrapper.get();

      // Change the state
      count.set(1);

      // Callback should fire synchronously
      assert.ok(
        callbackCount >= 1,
        `Expected callback to fire, got ${String(callbackCount)} calls`,
      );

      // Get pending should return the wrapper
      const pending = watcher.getPending();
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0], wrapper);
    });

    void test('updates propagate to receiver', async () => {
      const count = new Signal.State(0);

      using ctx = await setupSignalService({
        get count() {
          return count;
        },
        increment() {
          count.set(count.get() + 1);
        },
      });

      const remoteCount = await ctx.remote.count;
      assert.strictEqual(remoteCount.get(), 0);

      // Update the signal on sender side
      await ctx.remote.increment();

      // Wait for the batch update to propagate
      await waitMicrotasks(3);

      assert.strictEqual(remoteCount.get(), 1);
    });

    void test('multiple updates are batched', async () => {
      const a = new Signal.State(0);
      const b = new Signal.State(0);

      using ctx = await setupSignalService({
        get a() {
          return a;
        },
        get b() {
          return b;
        },
        updateBoth() {
          a.set(1);
          b.set(2);
        },
      });

      const [remoteA, remoteB] = await Promise.all([
        ctx.remote.a,
        ctx.remote.b,
      ]);

      assert.strictEqual(remoteA.get(), 0);
      assert.strictEqual(remoteB.get(), 0);

      // Update both signals
      await ctx.remote.updateBoth();

      // Wait for the batch update
      await waitMicrotasks(3);

      assert.strictEqual(remoteA.get(), 1);
      assert.strictEqual(remoteB.get(), 2);
    });

    void test('computed updates when dependency changes', async () => {
      const count = new Signal.State(5);
      const doubled = new Signal.Computed(() => count.get() * 2);

      using ctx = await setupSignalService({
        get count() {
          return count;
        },
        get doubled() {
          return doubled;
        },
        setCount(n: number) {
          count.set(n);
        },
      });

      const [remoteCount, remoteDoubled] = await Promise.all([
        ctx.remote.count,
        ctx.remote.doubled,
      ]);

      assert.strictEqual(remoteCount.get(), 5);
      assert.strictEqual(remoteDoubled.get(), 10);

      // Update the state signal
      await ctx.remote.setCount(10);

      // Wait for updates
      await waitMicrotasks(3);

      assert.strictEqual(remoteCount.get(), 10);
      assert.strictEqual(remoteDoubled.get(), 20);
    });
  });

  void suite('Signal reactivity', () => {
    void test('RemoteSignal works with Signal.Computed', async () => {
      const count = new Signal.State(5);

      using ctx = await setupSignalService({
        get count() {
          return count;
        },
        setCount(n: number) {
          count.set(n);
        },
      });

      // Note: The handler transforms Signal.State → RemoteSignal at runtime,
      // but RemoteProxy<T> type doesn't know about this transformation.
      const remoteCount = (await ctx.remote
        .count) as unknown as RemoteSignal<number>;

      // Create a local computed that depends on the remote signal
      const doubled = new Signal.Computed(() => remoteCount.get() * 2);

      assert.strictEqual(doubled.get(), 10);

      // Update sender
      await ctx.remote.setCount(10);
      await waitMicrotasks(3);

      // Local computed should update
      assert.strictEqual(doubled.get(), 20);
    });
  });

  void suite('Signal reuse', () => {
    void test('accessing same signal twice returns same RemoteSignal instance', async () => {
      const count = new Signal.State(42);

      using ctx = await setupSignalService({
        get count() {
          return count;
        },
      });

      const first = await ctx.remote.count;
      const second = await ctx.remote.count;

      // Should be the exact same object
      assert.strictEqual(first, second);
    });

    void test('sender tracks each signal only once', async () => {
      const count = new Signal.State(0);

      using ctx = await setupSignalService({
        get count() {
          return count;
        },
      });

      // Access the signal multiple times
      await ctx.remote.count;
      await ctx.remote.count;
      await ctx.remote.count;

      // Sender should only be tracking one signal
      assert.strictEqual(ctx.senderHandler._sentSignalCount, 1);
    });
  });

  void suite('Signal cleanup', () => {
    void test('releaseSignal removes signal from sender tracking', async () => {
      const count = new Signal.State(0);

      using ctx = await setupSignalService({
        get count() {
          return count;
        },
      });

      await ctx.remote.count;

      // Sender should be tracking the signal
      assert.strictEqual(ctx.senderHandler._sentSignalCount, 1);
      assert.strictEqual(ctx.senderHandler._isWatching(1), true);

      // Manually trigger release (simulating what happens when RemoteSignal is GC'd)
      ctx.senderHandler.releaseSignal(1);

      // Sender should no longer be tracking the signal
      assert.strictEqual(ctx.senderHandler._sentSignalCount, 0);
      assert.strictEqual(ctx.senderHandler._isWatching(1), false);
    });

    void test('signal:release message triggers cleanup on sender', async () => {
      const count = new Signal.State(0);

      using ctx = await setupSignalService({
        get count() {
          return count;
        },
      });

      await ctx.remote.count;

      // Sender should be tracking the signal
      assert.strictEqual(ctx.senderHandler._sentSignalCount, 1);

      // Simulate the receiver sending a release message
      // (normally triggered by FinalizationRegistry when RemoteSignal is GC'd)
      ctx.senderHandler.onMessage({type: 'signal:release', signalId: 1});

      // Sender should no longer be tracking the signal
      assert.strictEqual(ctx.senderHandler._sentSignalCount, 0);
    });

    void test('updates stop after signal is released', async () => {
      const count = new Signal.State(0);

      using ctx = await setupSignalService({
        get count() {
          return count;
        },
      });

      const remoteCount = (await ctx.remote
        .count) as unknown as RemoteSignal<number>;
      assert.strictEqual(remoteCount.get(), 0);

      // Update works before release
      count.set(1);
      await waitForMessages();
      assert.strictEqual(remoteCount.get(), 1);

      // Release the signal
      ctx.senderHandler.releaseSignal(1);

      // Update after release - value should not change on remote
      count.set(999);
      await waitForMessages();

      // Remote still has old value (no more updates being sent)
      assert.strictEqual(remoteCount.get(), 1);
    });

    void test('receiver tracks remote signals via WeakRef', async () => {
      const count = new Signal.State(0);

      using ctx = await setupSignalService({
        get count() {
          return count;
        },
      });

      await ctx.remote.count;

      // Receiver should be tracking the remote signal
      assert.strictEqual(ctx.receiverHandler._remoteSignalCount, 1);
    });
  });

  void suite('Nested proxies mode', () => {
    void test('signal value with nested function is proxied', async () => {
      const data = new Signal.State({
        value: 42,
        increment: () => 1,
      });

      using ctx = await setupSignalService(
        {
          get data() {
            return data;
          },
        },
        {nestedProxies: true},
      );

      const remoteData = (await ctx.remote.data) as unknown as RemoteSignal<{
        value: number;
        increment: () => number;
      }>;

      // Should have the cloned value
      assert.strictEqual(remoteData.get().value, 42);

      // The nested function should be proxied and callable
      const result = await remoteData.get().increment();
      assert.strictEqual(result, 1);
    });

    void test('signal update with cloneable nested values works', async () => {
      // Note: Signal updates with nestedProxies currently go through postMessage
      // directly, which means they follow structured clone semantics. Functions
      // and class instances in updates will fail with DataCloneError.
      // Only the *initial* value goes through the handler's toWire/fromWire.
      // This test verifies that updates with cloneable values still work.
      const data = new Signal.State({
        value: 0,
        nested: {count: 0},
      });

      using ctx = await setupSignalService(
        {
          get data() {
            return data;
          },
          updateData(n: number) {
            data.set({
              value: n,
              nested: {count: n * 2},
            });
          },
        },
        {nestedProxies: true},
      );

      const remoteData = (await ctx.remote.data) as unknown as RemoteSignal<{
        value: number;
        nested: {count: number};
      }>;

      assert.strictEqual(remoteData.get().value, 0);
      assert.strictEqual(remoteData.get().nested.count, 0);

      // Update the signal with cloneable values
      await ctx.remote.updateData(5);
      await waitForMessages();

      // Value should be updated
      assert.strictEqual(remoteData.get().value, 5);
      assert.strictEqual(remoteData.get().nested.count, 10);
    });

    void test('signal value with nested array of functions', async () => {
      const handlers = new Signal.State([() => 'first', () => 'second']);

      using ctx = await setupSignalService(
        {
          get handlers() {
            return handlers;
          },
        },
        {nestedProxies: true},
      );

      const remoteHandlers = (await ctx.remote
        .handlers) as unknown as RemoteSignal<Array<() => string>>;

      const arr = remoteHandlers.get();
      assert.strictEqual(arr.length, 2);
      assert.strictEqual(await arr[0]!(), 'first');
      assert.strictEqual(await arr[1]!(), 'second');
    });
  });
});
