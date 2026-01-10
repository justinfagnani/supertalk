/**
 * Tests for @supertalk/signals using real workers.
 *
 * These tests use actual worker threads to ensure the sender and receiver
 * have completely isolated signal graphs.
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {Signal} from 'signal-polyfill';
import {createWorker, waitForWorker} from './worker-utils.js';

void suite('@supertalk/signals (worker)', () => {
  void suite('Signal transfer', () => {
    void test('Signal.State is transferred with initial value', async () => {
      await using ctx = await createWorker('counter');
      const count = await ctx.remote.getCount();

      // Should receive a RemoteSignal, not a Signal.State
      assert.ok(
        !(count instanceof Signal.State),
        'Should not be a Signal.State',
      );
      assert.strictEqual(typeof count.get, 'function');
      assert.strictEqual(count.get(), 0);
    });

    void test('Signal.Computed is transferred with computed value', async () => {
      await using ctx = await createWorker('computed');
      const doubled = await ctx.remote.getDoubled();

      assert.strictEqual(doubled.get(), 0);
    });

    void test('multiple signals can be transferred', async () => {
      await using ctx = await createWorker('multi');
      const a = await ctx.remote.getA();
      const b = await ctx.remote.getB();
      const sum = await ctx.remote.getSum();

      assert.strictEqual(a.get(), 1);
      assert.strictEqual(b.get(), 2);
      assert.strictEqual(sum.get(), 3);
    });
  });

  void suite('Signal updates', () => {
    void test('updates propagate to receiver', async () => {
      await using ctx = await createWorker('counter', {
        signalHandlerOptions: {autoWatch: true},
      });
      const count = await ctx.remote.getCount();
      assert.strictEqual(count.get(), 0);

      // Mutate on the worker side
      await ctx.remote.setCount(42);

      // Wait for the batch update to propagate
      await waitForWorker();

      assert.strictEqual(count.get(), 42);
    });

    void test('multiple updates are batched', async () => {
      await using ctx = await createWorker('counter', {
        signalHandlerOptions: {autoWatch: true},
      });
      const count = await ctx.remote.getCount();
      assert.strictEqual(count.get(), 0);

      // Call increment multiple times rapidly
      await ctx.remote.increment();
      await ctx.remote.increment();
      await ctx.remote.increment();

      // Wait for updates
      await waitForWorker();

      // Should have all updates
      assert.strictEqual(count.get(), 3);
    });

    void test('computed updates when dependency changes', async () => {
      await using ctx = await createWorker('computed', {
        signalHandlerOptions: {autoWatch: true},
      });
      const doubled = await ctx.remote.getDoubled();
      assert.strictEqual(doubled.get(), 0);

      // Change the underlying count
      await ctx.remote.setCount(5);
      await waitForWorker();

      assert.strictEqual(doubled.get(), 10);
    });
  });

  void suite('Signal reactivity', () => {
    void test('RemoteSignal works with local Signal.Computed', async () => {
      await using ctx = await createWorker('counter', {
        signalHandlerOptions: {autoWatch: true},
      });
      const count = await ctx.remote.getCount();

      // Create a local computed that depends on the remote signal
      const localDoubled = new Signal.Computed(() => count.get() * 2);
      assert.strictEqual(localDoubled.get(), 0);

      // Update the remote signal
      await ctx.remote.setCount(21);
      await waitForWorker();

      // Local computed should update
      assert.strictEqual(localDoubled.get(), 42);
    });

    void test('isolated signal graphs do not interfere', async () => {
      // Create a local signal with the same pattern
      const localCount = new Signal.State(100);

      await using ctx = await createWorker('counter', {
        signalHandlerOptions: {autoWatch: true},
      });
      const remoteCount = await ctx.remote.getCount();

      // They should be completely independent
      assert.strictEqual(localCount.get(), 100);
      assert.strictEqual(remoteCount.get(), 0);

      // Changing one should not affect the other
      localCount.set(200);
      assert.strictEqual(localCount.get(), 200);
      assert.strictEqual(remoteCount.get(), 0);

      await ctx.remote.setCount(50);
      await waitForWorker();
      assert.strictEqual(localCount.get(), 200);
      assert.strictEqual(remoteCount.get(), 50);
    });
  });
});
