/**
 * Tests for cyclic payload handling.
 *
 * Cyclic object graphs (where an object references itself directly or
 * indirectly) must not cause infinite recursion in debug or nested proxy mode.
 *
 * Structured clone handles cycles natively, so we need to ensure our
 * traversal code in debug/nested mode doesn't infinitely loop.
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';

// =============================================================================
// Test interfaces
// =============================================================================

interface Node {
  value: number;
  next?: Node;
}

interface TreeNode {
  value: string;
  children: Array<TreeNode>;
  parent?: TreeNode;
}

// =============================================================================
// Cycle tests - shallow mode (nestedProxies: false)
// =============================================================================

void suite('cyclic payloads - shallow mode', () => {
  void test('self-referencing object is cloned correctly', async () => {
    await using ctx = await setupService({
      echo(obj: Record<string, unknown>): Record<string, unknown> {
        return obj;
      },
    });

    // Create an object that references itself
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: Record<string, any> = {value: 42};
    obj['self'] = obj;

    const result = await ctx.remote.echo(obj);

    // The result should be cloned - not the same object
    assert.notStrictEqual(result, obj);
    // But it should have the same structure
    assert.strictEqual(result['value'], 42);
    // And the cycle should be preserved
    assert.strictEqual(result['self'], result);
  });

  void test('mutually referencing objects are cloned correctly', async () => {
    await using ctx = await setupService({
      echo(a: Node, b: Node): [Node, Node] {
        return [a, b];
      },
    });

    // Create two objects that reference each other
    const a: Node = {value: 1};
    const b: Node = {value: 2};
    a.next = b;
    b.next = a;

    const [resultA, resultB] = await ctx.remote.echo(a, b);

    assert.ok(resultA);
    assert.ok(resultB);
    assert.strictEqual(resultA.value, 1);
    assert.strictEqual(resultB.value, 2);
    assert.strictEqual(resultA.next, resultB);
    assert.strictEqual(resultB.next, resultA);
  });

  void test('array with cycle is cloned correctly', async () => {
    await using ctx = await setupService({
      echo(arr: Array<unknown>): Array<unknown> {
        return arr;
      },
    });

    // Create an array that contains itself
    const arr: Array<unknown> = [1, 2, 3];
    arr.push(arr);

    const result = await ctx.remote.echo(arr);

    assert.notStrictEqual(result, arr);
    assert.strictEqual(result[0], 1);
    assert.strictEqual(result[1], 2);
    assert.strictEqual(result[2], 3);
    assert.strictEqual(result[3], result);
  });
});

// =============================================================================
// Cycle tests - debug mode
// =============================================================================

void suite('cyclic payloads - debug mode', () => {
  void test('self-referencing object does not cause infinite loop', async () => {
    await using ctx = await setupService(
      {
        echo(obj: Record<string, unknown>): Record<string, unknown> {
          return obj;
        },
      },
      {debug: true},
    );

    // Create an object that references itself
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: Record<string, any> = {value: 42};
    obj['self'] = obj;

    const result = await ctx.remote.echo(obj);

    assert.strictEqual(result['value'], 42);
    assert.strictEqual(result['self'], result);
  });

  void test('deeply nested cycle is handled', async () => {
    await using ctx = await setupService(
      {
        echo(obj: Record<string, unknown>): Record<string, unknown> {
          return obj;
        },
      },
      {debug: true},
    );

    // Create a chain of objects where the last points to the first
    const first: Record<string, unknown> = {level: 0};
    let current = first;
    for (let i = 1; i < 10; i++) {
      const next: Record<string, unknown> = {level: i};
      current['next'] = next;
      current = next;
    }
    // Create the cycle
    current['next'] = first;

    const result = await ctx.remote.echo(first);

    assert.strictEqual(result['level'], 0);
    // Traverse the chain and verify cycle
    let node = result;
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(node['level'], i);
      node = node['next'] as Record<string, unknown>;
    }
    // Should be back at the start
    assert.strictEqual(node, result);
  });

  void test('tree with parent back-references does not loop', async () => {
    await using ctx = await setupService(
      {
        echo(tree: TreeNode): TreeNode {
          return tree;
        },
      },
      {debug: true},
    );

    // Create a tree with parent references (common pattern)
    const root: TreeNode = {value: 'root', children: []};
    const child1: TreeNode = {value: 'child1', children: [], parent: root};
    const child2: TreeNode = {value: 'child2', children: [], parent: root};
    root.children.push(child1, child2);

    const result = await ctx.remote.echo(root);

    assert.strictEqual(result.value, 'root');
    assert.strictEqual(result.children.length, 2);
    const resultChild0 = result.children[0];
    const resultChild1 = result.children[1];
    assert.ok(resultChild0);
    assert.ok(resultChild1);
    assert.strictEqual(resultChild0.value, 'child1');
    assert.strictEqual(resultChild0.parent, result);
    assert.strictEqual(resultChild1.value, 'child2');
    assert.strictEqual(resultChild1.parent, result);
  });
});

// =============================================================================
// Cycle tests - nested proxy mode
// =============================================================================

void suite('cyclic payloads - nested proxy mode', () => {
  void test('self-referencing object is handled', async () => {
    await using ctx = await setupService(
      {
        echo(obj: Record<string, unknown>): Record<string, unknown> {
          return obj;
        },
      },
      {nestedProxies: true},
    );

    // Create an object that references itself
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: Record<string, any> = {value: 42};
    obj['self'] = obj;

    const result = await ctx.remote.echo(obj);

    assert.strictEqual(result['value'], 42);
    assert.strictEqual(result['self'], result);
  });

  void test('cycle with proxied function does not loop', async () => {
    await using ctx = await setupService(
      {
        echo(obj: Record<string, unknown>): Record<string, unknown> {
          return obj;
        },
      },
      {nestedProxies: true},
    );

    // Create a cycle containing a function
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: Record<string, any> = {
      value: 42,
      callback: () => 'hello',
    };
    obj['self'] = obj;

    const result = await ctx.remote.echo(obj);

    assert.strictEqual(result['value'], 42);
    // The callback should be proxied
    assert.strictEqual(typeof result['callback'], 'function');
    // The cycle should be preserved
    assert.strictEqual(result['self'], result);
  });

  void test('diamond-shaped graph is preserved', async () => {
    await using ctx = await setupService(
      {
        echo(obj: Record<string, unknown>): Record<string, unknown> {
          return obj;
        },
      },
      {nestedProxies: true},
    );

    // Create a diamond: root -> [left, right] -> shared
    const shared = {value: 'shared'};
    const left = {name: 'left', child: shared};
    const right = {name: 'right', child: shared};
    const root = {left, right};

    const result = await ctx.remote.echo(root);

    // The shared object should be the same instance on both sides
    assert.strictEqual(
      (result['left'] as typeof left).child,
      (result['right'] as typeof right).child,
    );
  });

  void test('complex nested cycle with multiple entry points', async () => {
    await using ctx = await setupService(
      {
        echoTwo(
          a: Record<string, unknown>,
          b: Record<string, unknown>,
        ): [Record<string, unknown>, Record<string, unknown>] {
          return [a, b];
        },
      },
      {nestedProxies: true},
    );

    // Create two objects that both reference a shared cyclic structure
    const shared: Record<string, unknown> = {value: 'shared'};
    shared['self'] = shared;

    const a: Record<string, unknown> = {name: 'a', ref: shared};
    const b: Record<string, unknown> = {name: 'b', ref: shared};

    const [resultA, resultB] = await ctx.remote.echoTwo(a, b);

    assert.ok(resultA);
    assert.ok(resultB);
    assert.strictEqual(resultA['name'], 'a');
    assert.strictEqual(resultB['name'], 'b');

    // Both should reference the same shared object
    const sharedA = resultA['ref'] as Record<string, unknown>;
    const sharedB = resultB['ref'] as Record<string, unknown>;
    assert.strictEqual(sharedA, sharedB);

    // The shared object should still have its self-reference
    assert.strictEqual(sharedA['self'], sharedA);
  });

  void test('same function referenced multiple times yields same proxy', async () => {
    await using ctx = await setupService(
      {
        echo(obj: Record<string, unknown>): Record<string, unknown> {
          return obj;
        },
      },
      {nestedProxies: true},
    );

    // Create an object where the same function is referenced twice
    const sharedFn = () => 'hello';
    const obj = {
      fn1: sharedFn,
      fn2: sharedFn,
    };

    const result = await ctx.remote.echo(obj);

    // Both properties should reference the same proxied function
    assert.strictEqual(result['fn1'], result['fn2']);
    // And it should still work
    assert.strictEqual(
      await (result['fn1'] as () => Promise<string>)(),
      'hello',
    );
  });

  void test('same promise referenced multiple times yields same proxy', async () => {
    await using ctx = await setupService(
      {
        echo(obj: Record<string, unknown>): Record<string, unknown> {
          return obj;
        },
      },
      {nestedProxies: true},
    );

    // Create an object where the same promise is referenced twice
    const sharedPromise = Promise.resolve(42);
    const obj = {
      p1: sharedPromise,
      p2: sharedPromise,
    };

    const result = await ctx.remote.echo(obj);

    // Both properties should reference the same proxied promise
    assert.strictEqual(result['p1'], result['p2']);
    // And it should resolve correctly
    assert.strictEqual(await (result['p1'] as Promise<number>), 42);
  });
});
