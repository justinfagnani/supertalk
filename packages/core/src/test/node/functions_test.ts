/**
 * Tests for function proxying.
 *
 * Functions can appear in various positions:
 * - As arguments to method calls
 * - As return values from method calls
 * - Nested inside objects/arrays in arguments
 * - Nested inside objects/arrays in return values
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';

void suite('function proxying', () => {
  void suite('functions as arguments', () => {
    void test('callback is invoked', async () => {
      using ctx = setupService({
        callWithValue(value: number, callback: (v: number) => void): void {
          callback(value * 2);
        },
      });

      const result = await new Promise<number>((resolve) => {
        void ctx.remote.callWithValue(21, resolve);
      });
      assert.strictEqual(result, 42);
    });

    void test('callback with return value', async () => {
      using ctx = setupService({
        transform(value: string, fn: (s: string) => string): string {
          return fn(value);
        },
      });

      const result = await ctx.remote.transform('hello', (s) =>
        s.toUpperCase(),
      );
      assert.strictEqual(result, 'HELLO');
    });

    void test('multiple callbacks', async () => {
      using ctx = setupService({
        compute(
          a: number,
          b: number,
          onSuccess: (result: number) => void,
          onError: (error: string) => void,
        ): void {
          if (b === 0) {
            onError('Division by zero');
          } else {
            onSuccess(a / b);
          }
        },
      });

      // Test success case
      const successResult = await new Promise<number>((resolve) => {
        void ctx.remote.compute(10, 2, resolve, () => {
          assert.fail('Should not call error callback');
        });
      });
      assert.strictEqual(successResult, 5);

      // Test error case
      const errorResult = await new Promise<string>((resolve) => {
        void ctx.remote.compute(
          10,
          0,
          () => {
            assert.fail('Should not call success callback');
          },
          resolve,
        );
      });
      assert.strictEqual(errorResult, 'Division by zero');
    });

    void test('callback invoked multiple times', async () => {
      using ctx = setupService({
        forEach(items: Array<number>, callback: (item: number) => void): void {
          for (const item of items) {
            callback(item);
          }
        },
      });

      const received: Array<number> = [];
      await new Promise<void>((resolve) => {
        void ctx.remote.forEach([1, 2, 3], (item) => {
          received.push(item);
          if (received.length === 3) {
            resolve();
          }
        });
      });
      assert.deepStrictEqual(received, [1, 2, 3]);
    });
  });

  void suite('functions as return values', () => {
    void test('returned function can be invoked', async () => {
      using ctx = setupService({
        getMultiplier(factor: number): (n: number) => number {
          return (n) => n * factor;
        },
      });

      const double = await ctx.remote.getMultiplier(2);
      // TODO: Remote<T> should recursively transform nested functions.
      // `double` should be typed as `(n: number) => Promise<number>` but is
      // currently `(n: number) => number`. See types.ts for the fix.
      const result = await (
        double as unknown as (n: number) => Promise<number>
      )(21);
      assert.strictEqual(result, 42);
    });

    void test('returned function maintains closure', async () => {
      using ctx = setupService({
        createCounter(): () => number {
          let count = 0;
          return () => ++count;
        },
      });

      const counter = await ctx.remote.createCounter();
      const typedCounter = counter as unknown as () => Promise<number>;

      assert.strictEqual(await typedCounter(), 1);
      assert.strictEqual(await typedCounter(), 2);
      assert.strictEqual(await typedCounter(), 3);
    });
  });

  void suite('functions nested in objects', () => {
    void test('callback in object argument', async () => {
      interface Options {
        value: number;
        onComplete: (result: number) => void;
      }

      // Nested functions require autoProxy: true
      using ctx = setupService(
        {
          processWithOptions(options: Options): void {
            options.onComplete(options.value * 2);
          },
        },
        {autoProxy: true},
      );

      const result = await new Promise<number>((resolve) => {
        void ctx.remote.processWithOptions({
          value: 21,
          onComplete: resolve,
        });
      });
      assert.strictEqual(result, 42);
    });

    void test('function in returned object', async () => {
      interface Widget {
        name: string;
        activate: () => string;
      }

      // Nested functions require autoProxy: true
      using ctx = setupService(
        {
          createWidget(name: string): Widget {
            return {
              name,
              activate: () => `${name} activated!`,
            };
          },
        },
        {autoProxy: true},
      );

      const widget = await ctx.remote.createWidget('Button');
      // Name is cloned (data)
      assert.strictEqual(widget.name, 'Button');
      // activate is proxied (function)
      // TODO: This should not require a cast once nested functions are handled
      // in Remote<T>
      const activateFn = widget.activate as unknown as () => Promise<string>;
      assert.strictEqual(await activateFn(), 'Button activated!');
    });
  });

  void suite('functions nested in arrays', () => {
    void test('callbacks in array argument', async () => {
      // Nested functions require autoProxy: true
      using ctx = setupService(
        {
          invokeAll(callbacks: Array<() => void>): void {
            for (const cb of callbacks) {
              cb();
            }
          },
        },
        {autoProxy: true},
      );

      let count = 0;
      await new Promise<void>((resolve) => {
        void ctx.remote.invokeAll([
          () => {
            count++;
          },
          () => {
            count++;
          },
          () => {
            count++;
            resolve();
          },
        ]);
      });
      assert.strictEqual(count, 3);
    });

    void test('functions in returned array', async () => {
      // Nested functions require autoProxy: true
      using ctx = setupService(
        {
          getOperations(): Array<(n: number) => number> {
            return [(n) => n + 1, (n) => n * 2, (n) => n ** 2];
          },
        },
        {autoProxy: true},
      );

      const ops = await ctx.remote.getOperations();
      type Op = (n: number) => Promise<number>;
      const [addOne, double, square] = ops as unknown as [Op, Op, Op];

      assert.strictEqual(await addOne(5), 6); // 5 + 1
      assert.strictEqual(await double(5), 10); // 5 * 2
      assert.strictEqual(await square(5), 25); // 5 ** 2
    });
  });
});
