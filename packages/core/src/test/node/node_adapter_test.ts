/**
 * Tests for the Node.js endpoint adapter.
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {wrap} from '../../index.js';
import {nodeEndpoint} from '../../node.js';

void suite('nodeEndpoint', () => {
  void test('wraps a Worker for use with wrap()', async () => {
    const worker = new Worker(
      new URL('./node-worker-fixture.js', import.meta.url),
    );

    try {
      const remote = await wrap<{
        add(a: number, b: number): number;
        greet(name: string): Promise<string>;
      }>(nodeEndpoint(worker));

      // Test sync method
      const sum = await remote.add(2, 3);
      assert.equal(sum, 5);

      // Test async method
      const greeting = await remote.greet('World');
      assert.equal(greeting, 'Hello, World!');
    } finally {
      await worker.terminate();
    }
  });

  void test('handles multiple calls', async () => {
    const worker = new Worker(
      new URL('./node-worker-fixture.js', import.meta.url),
    );

    try {
      const remote = await wrap<{
        add(a: number, b: number): number;
      }>(nodeEndpoint(worker));

      const results = await Promise.all([
        remote.add(1, 2),
        remote.add(3, 4),
        remote.add(5, 6),
      ]);

      assert.deepEqual(results, [3, 7, 11]);
    } finally {
      await worker.terminate();
    }
  });
});
