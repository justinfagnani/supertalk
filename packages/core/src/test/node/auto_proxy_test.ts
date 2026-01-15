/**
 * Tests for nestedProxies mode behavior.
 *
 * This file tests both manual mode (nestedProxies: false, the default) and
 * nested proxy mode (nestedProxies: true).
 *
 * In manual mode:
 * - Top-level functions are auto-proxied
 * - Class instances require explicit proxy() markers
 * - Nested functions/class instances throw NonCloneableError
 *
 * In nested proxy mode:
 * - Functions and promises anywhere in the graph are auto-proxied
 * - Class instances require explicit proxy() markers
 * - Diamond-shaped object graphs result in the same proxy instance
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';
import {NonCloneableError, proxy} from '../../index.js';
import type {Remoted, AsyncProxy} from '../../index.js';

// A class instance for testing (not a plain object)
class Counter {
  #count = 0;

  increment(): number {
    return ++this.#count;
  }

  get value(): number {
    return this.#count;
  }
}

void suite('manual mode (nestedProxies: false)', () => {
  void suite('top-level values are proxied', () => {
    void test('top-level function argument is proxied', async () => {
      await using ctx = await setupService({
        callMe(fn: () => string): string {
          return fn();
        },
      });

      const result = await ctx.remote.callMe(() => 'hello');
      assert.strictEqual(result, 'hello');
    });

    void test('top-level function return value is proxied', async () => {
      await using ctx = await setupService({
        getGreeter(): () => string {
          return () => 'hello from remote';
        },
      });

      // Remote<T> uses Remoted<R> for return types, so greeter is correctly
      // typed as () => Promise<string>
      const greeter = await ctx.remote.getGreeter();
      // eslint-disable-next-line @typescript-eslint/await-thenable
      const result = await greeter();
      assert.strictEqual(result, 'hello from remote');
    });

    void test('top-level class instance argument is proxied with proxy()', async () => {
      await using ctx = await setupService({
        // When the counter is passed with proxy(), it becomes a proxy on this side.
        // Proxy methods return promises, so we must await them.
        // We use Remoted<Counter> for the parameter type since we receive
        // a proxy, not the original counter.
        async useCounter(counter: Remoted<Counter>): Promise<number> {
          // The counter here is a proxy to the local Counter instance
          // eslint-disable-next-line @typescript-eslint/await-thenable
          await counter.increment();
          return counter.increment() as unknown as number;
        },
      });

      const counter = new Counter();
      // Use proxy() to explicitly proxy the class instance
      const result = await ctx.remote.useCounter(
        proxy(counter) as unknown as Remoted<Counter>,
      );
      // The proxy calls back to our local counter
      assert.strictEqual(result, 2);
      assert.strictEqual(counter.value, 2);
    });

    void test('top-level class instance return value is proxied with proxy()', async () => {
      await using ctx = await setupService({
        createCounter(): AsyncProxy<Counter> {
          return proxy(new Counter());
        },
      });

      // Counter is proxied; Remoted<Counter> makes methods async
      const counter = await ctx.remote.createCounter();
      assert.strictEqual(await counter.increment(), 1);
      assert.strictEqual(await counter.increment(), 2);
    });
  });

  void suite('nested non-cloneable values throw (debug mode)', () => {
    void test('nested function in object argument throws', async () => {
      // debug: true enables helpful error messages with paths
      await using ctx = await setupService(
        {
          processOptions(opts: {name: string; onChange: () => void}): void {
            opts.onChange();
          },
        },
        {debug: true},
      );

      await assert.rejects(
        async () => {
          await ctx.remote.processOptions({
            name: 'test',
            onChange: () => {
              /* intentionally empty for test */
            },
          });
        },
        (error: Error) => {
          assert.ok(
            error instanceof NonCloneableError,
            `Expected NonCloneableError but got ${error.constructor.name}`,
          );
          assert.strictEqual(error.valueType, 'function');
          assert.strictEqual(error.path, 'onChange');
          return true;
        },
      );
    });

    void test('nested function in array argument throws', async () => {
      await using ctx = await setupService(
        {
          processList(items: Array<() => void>): void {
            for (const fn of items) fn();
          },
        },
        {debug: true},
      );

      await assert.rejects(
        async () => {
          await ctx.remote.processList([
            () => {
              /* intentionally empty */
            },
            () => {
              /* intentionally empty */
            },
          ]);
        },
        (error: Error) => {
          assert.ok(error instanceof NonCloneableError);
          assert.strictEqual(error.valueType, 'function');
          assert.strictEqual(error.path, '[0]');
          return true;
        },
      );
    });

    void test('deeply nested function throws with path', async () => {
      await using ctx = await setupService(
        {
          deepProcess(data: {level1: {level2: {fn: () => void}}}): void {
            data.level1.level2.fn();
          },
        },
        {debug: true},
      );

      await assert.rejects(
        async () => {
          await ctx.remote.deepProcess({
            level1: {
              level2: {
                fn: () => {
                  /* intentionally empty */
                },
              },
            },
          });
        },
        (error: Error) => {
          assert.ok(error instanceof NonCloneableError);
          assert.strictEqual(error.valueType, 'function');
          assert.strictEqual(error.path, 'level1.level2.fn');
          return true;
        },
      );
    });

    void test('nested function in return value throws', async () => {
      await using ctx = await setupService(
        {
          getConfig(): {name: string; validate: () => boolean} {
            return {
              name: 'test',
              validate: () => true,
            };
          },
        },
        {debug: true},
      );

      // The error happens on the expose side when serializing the return value
      // It should propagate back as a throw message
      await assert.rejects(
        async () => {
          await ctx.remote.getConfig();
        },
        (error: Error) => {
          // The error is serialized and deserialized, so it's a plain Error
          assert.ok(error.message.includes('validate'));
          assert.ok(error.message.includes('nestedProxies'));
          return true;
        },
      );
    });
  });

  void suite('promises in debug mode', () => {
    void test('promise return values are awaited on service side', async () => {
      // When a service method returns a Promise, the RPC layer awaits it
      // before sending the resolved value. This is correct behavior for
      // async methods - it's what you'd expect from RPC semantics.
      await using ctx = await setupService({
        getPromise(): Promise<number> {
          return Promise.resolve(42);
        },
      });

      // The promise is awaited on the service side, so we get the resolved value
      const result = await ctx.remote.getPromise();
      assert.strictEqual(result, 42);
    });

    void test('nested promise throws in debug mode', async () => {
      // When a method returns an object that CONTAINS a promise property,
      // in debug mode the Promise (which is a class instance) will throw
      // because nested class instances are not allowed.
      await using ctx = await setupService(
        {
          getDataWithPromise(): {name: string; data: Promise<number>} {
            return {name: 'test', data: Promise.resolve(42)};
          },
        },
        {debug: true},
      );

      await assert.rejects(
        async () => {
          await ctx.remote.getDataWithPromise();
        },
        (error: Error) => {
          // The error is serialized and deserialized, so it becomes a plain Error
          // with the original message
          assert.ok(error.message.includes('data'));
          assert.ok(error.message.includes('nestedProxies'));
          return true;
        },
      );
    });
  });

  void suite('nested markers throw in debug mode', () => {
    void test('nested proxy() marker throws', async () => {
      await using ctx = await setupService(
        {
          processData(data: {widget: AsyncProxy<Counter>}): void {
            // Would access the proxied widget
            void data.widget;
          },
        },
        {debug: true},
      );

      await assert.rejects(
        async () => {
          await ctx.remote.processData({
            widget: proxy(new Counter()),
          });
        },
        (error: Error) => {
          assert.ok(error instanceof NonCloneableError);
          assert.strictEqual(error.valueType, 'proxy');
          assert.strictEqual(error.path, 'widget');
          return true;
        },
      );
    });

    void test('nested transfer() marker throws', async () => {
      const {transfer} = await import('../../index.js');

      await using ctx = await setupService(
        {
          processData(data: {buffer: ArrayBuffer}): number {
            return data.buffer.byteLength;
          },
        },
        {debug: true},
      );

      await assert.rejects(
        async () => {
          await ctx.remote.processData({
            buffer: transfer(new ArrayBuffer(1024)) as unknown as ArrayBuffer,
          });
        },
        (error: Error) => {
          assert.ok(error instanceof NonCloneableError);
          assert.strictEqual(error.valueType, 'transfer');
          assert.strictEqual(error.path, 'buffer');
          return true;
        },
      );
    });

    void test('top-level proxy() marker works without nestedProxies', async () => {
      // Top-level markers should work fine - only nested ones throw
      await using ctx = await setupService(
        {
          useCounter(counter: Remoted<Counter>): number {
            return counter.increment() as unknown as number;
          },
        },
        {debug: true},
      );

      const counter = new Counter();
      const result = await ctx.remote.useCounter(
        proxy(counter) as unknown as Remoted<Counter>,
      );
      assert.strictEqual(result, 1);
    });

    void test('top-level transfer() marker works without nestedProxies', async () => {
      const {transfer} = await import('../../index.js');

      await using ctx = await setupService(
        {
          getBufferSize(buffer: ArrayBuffer): number {
            return buffer.byteLength;
          },
        },
        {debug: true},
      );

      const result = await ctx.remote.getBufferSize(
        transfer(new ArrayBuffer(1024)) as unknown as ArrayBuffer,
      );
      assert.strictEqual(result, 1024);
    });
  });
});

void suite('nested proxy mode (nestedProxies: true)', () => {
  void suite('nested values are proxied', () => {
    void test('nested function in object argument is proxied', async () => {
      await using ctx = await setupService(
        {
          processOptions(opts: {name: string; onChange: () => string}): string {
            return opts.onChange();
          },
        },
        {nestedProxies: true},
      );

      const result = await ctx.remote.processOptions({
        name: 'test',
        onChange: () => 'callback called!',
      });
      assert.strictEqual(result, 'callback called!');
    });

    void test('nested function in array argument is proxied', async () => {
      await using ctx = await setupService(
        {
          // When functions are proxied, they return promises
          async callAll(fns: Array<() => number>): Promise<number> {
            let sum = 0;
            for (const fn of fns) {
              sum += await (fn as unknown as () => Promise<number>)();
            }
            return sum;
          },
        },
        {nestedProxies: true},
      );

      const result = await ctx.remote.callAll([() => 1, () => 2, () => 3]);
      assert.strictEqual(result, 6);
    });

    void test('deeply nested function is proxied', async () => {
      await using ctx = await setupService(
        {
          deepCall(data: {level1: {level2: {fn: () => string}}}): string {
            return data.level1.level2.fn();
          },
        },
        {nestedProxies: true},
      );

      const result = await ctx.remote.deepCall({
        level1: {level2: {fn: () => 'deep callback'}},
      });
      assert.strictEqual(result, 'deep callback');
    });

    void test('nested class instance with proxy() marker is proxied', async () => {
      await using ctx = await setupService(
        {
          // When the counter is wrapped with proxy(), it's proxied and methods return promises
          async useNestedCounter(opts: {
            counter: AsyncProxy<Counter>;
          }): Promise<number> {
            const counter = opts.counter as unknown as {
              increment: () => Promise<number>;
            };
            await counter.increment();
            return counter.increment();
          },
        },
        {nestedProxies: true},
      );

      const counter = new Counter();
      // Use proxy() to explicitly mark the class instance for proxying
      const result = await ctx.remote.useNestedCounter({
        counter: proxy(counter),
      });
      assert.strictEqual(result, 2);
      assert.strictEqual(counter.value, 2);
    });

    void test('nested function in return value is proxied', async () => {
      await using ctx = await setupService(
        {
          getWidget(): {name: string; activate: () => string} {
            return {
              name: 'Button',
              activate: () => 'Button activated!',
            };
          },
        },
        {nestedProxies: true},
      );

      const widget = await ctx.remote.getWidget();
      assert.strictEqual(widget.name, 'Button');
      const activateFn = widget.activate as unknown as () => Promise<string>;
      assert.strictEqual(await activateFn(), 'Button activated!');
    });

    void test('nested class instance with proxy() in return value is proxied', async () => {
      await using ctx = await setupService(
        {
          getCounterHolder(): {counter: AsyncProxy<Counter>} {
            // Use proxy() to explicitly mark the class instance
            return {counter: proxy(new Counter())};
          },
        },
        {nestedProxies: true},
      );

      const holder = await ctx.remote.getCounterHolder();
      const counter = holder.counter as unknown as {
        increment: () => Promise<number>;
      };
      assert.strictEqual(await counter.increment(), 1);
      assert.strictEqual(await counter.increment(), 2);
    });
  });

  void suite('diamond object graphs', () => {
    void test('same object referenced twice yields same proxy', async () => {
      const sharedFn = () => 42;

      await using ctx = await setupService(
        {
          processShared(data: {a: () => number; b: () => number}): boolean {
            // Both references should be to the same proxied function
            return data.a === data.b;
          },
        },
        {nestedProxies: true},
      );

      // On the local side, a and b are the same function
      const result = await ctx.remote.processShared({
        a: sharedFn,
        b: sharedFn,
      });
      // On the remote side, after deserialization, they should still be ===
      assert.strictEqual(result, true);
    });

    void test('diamond with proxy() marker preserves identity', async () => {
      await using ctx = await setupService(
        {
          checkIdentity(data: {
            a: AsyncProxy<Counter>;
            b: AsyncProxy<Counter>;
          }): boolean {
            return data.a === data.b;
          },
        },
        {nestedProxies: true},
      );

      const sharedCounter = new Counter();
      // Use proxy() to mark the shared counter, and pass the same reference twice
      const wrapped = proxy(sharedCounter);
      const result = await ctx.remote.checkIdentity({
        a: wrapped,
        b: wrapped,
      });
      assert.strictEqual(result, true);
    });

    void test('diamond in return value preserves identity', async () => {
      await using ctx = await setupService(
        {
          getDiamond(): {a: () => number; b: () => number} {
            const shared = () => 42;
            return {a: shared, b: shared};
          },
        },
        {nestedProxies: true},
      );

      const result = await ctx.remote.getDiamond();
      // After receiving the diamond, both should be the same proxy
      assert.strictEqual(result.a, result.b);
    });
  });

  void suite('promises in nested proxy mode', () => {
    // Note: Promises are not specially handled yet (that's Phase 6).
    // In nested proxy mode, Promise is not a plain object, so it gets proxied.
    // This test documents current behavior.
    void test('nested promise is proxied (not resolved)', async () => {
      await using ctx = await setupService(
        {
          getWithPromise(): {data: Promise<number>} {
            return {data: Promise.resolve(42)};
          },
        },
        {nestedProxies: true},
      );

      const result = await ctx.remote.getWithPromise();
      // The promise is proxied as an object, not specially handled.
      // result.data is a proxy (function type because proxies use function target)
      assert.ok(
        typeof result.data === 'function' || typeof result.data === 'object',
      );
      // Phase 6 will make this work: await result.data === 42
    });
  });

  void suite('class instances in nested proxy mode', () => {
    // Class instances are not plain objects, so they are NOT recursively
    // traversed. Instead, they pass through to structured clone.
    // Structured clone silently drops the prototype and methods,
    // resulting in a plain object on the receiving side.

    void test('class instance without proxy() becomes empty object', async () => {
      await using ctx = await setupService(
        {
          describeCounter(counter: Counter): string {
            // The counter arrives as a plain object {}, not a Counter instance
            const hasIncrement = 'increment' in counter;
            const proto = Object.getPrototypeOf(counter);
            return `hasIncrement=${hasIncrement}, proto=${proto?.constructor?.name ?? 'null'}`;
          },
        },
        {nestedProxies: true},
      );

      // Passing a class instance without proxy() marker - structured clone
      // silently converts it to a plain object, losing all methods
      const result = await ctx.remote.describeCounter(
        new Counter() as unknown as Counter,
      );
      // The instance becomes {} - no methods, plain Object prototype
      assert.strictEqual(result, 'hasIncrement=false, proto=Object');
    });

    void test('class instance with proxy() marker works in nested proxy mode', async () => {
      await using ctx = await setupService(
        {
          async useCounter(counter: AsyncProxy<Counter>): Promise<number> {
            return await counter.increment();
          },
        },
        {nestedProxies: true},
      );

      const counter = new Counter();
      const result = await ctx.remote.useCounter(
        proxy(counter) as unknown as AsyncProxy<Counter>,
      );
      assert.strictEqual(result, 1);
    });

    void test('nested class instance in object becomes empty object', async () => {
      await using ctx = await setupService(
        {
          describeData(data: {name: string; counter: Counter}): string {
            const hasIncrement = 'increment' in data.counter;
            const proto = Object.getPrototypeOf(data.counter);
            return `name=${data.name}, hasIncrement=${hasIncrement}, proto=${proto?.constructor?.name ?? 'null'}`;
          },
        },
        {nestedProxies: true},
      );

      // Nested class instance also becomes a plain object
      const result = await ctx.remote.describeData({
        name: 'test',
        counter: new Counter() as unknown as Counter,
      });
      assert.strictEqual(result, 'name=test, hasIncrement=false, proto=Object');
    });

    void test('nested class instance with proxy() marker works', async () => {
      await using ctx = await setupService(
        {
          async processData(data: {
            name: string;
            counter: AsyncProxy<Counter>;
          }): Promise<string> {
            const val = await data.counter.increment();
            return `${data.name}: ${val}`;
          },
        },
        {nestedProxies: true},
      );

      const counter = new Counter();
      const result = await ctx.remote.processData({
        name: 'test',
        counter: proxy(counter) as unknown as AsyncProxy<Counter>,
      });
      assert.strictEqual(result, 'test: 1');
    });

    void test('data-only class instances clone successfully', async () => {
      // Classes that have no methods (only data) can be cloned,
      // but they become plain objects on the other side
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }

      await using ctx = await setupService(
        {
          sumPoint(point: Point): number {
            // Note: point is a plain object on this side, not a Point instance
            return point.x + point.y;
          },
        },
        {nestedProxies: true},
      );

      const result = await ctx.remote.sumPoint(new Point(10, 20));
      assert.strictEqual(result, 30);
    });
  });
});
