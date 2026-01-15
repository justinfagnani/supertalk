import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';

void suite('Promise support', () => {
  void suite('Top-level promise return values', () => {
    void test('promise as return value resolves correctly', async () => {
      await using ctx = await setupService({
        getAsync(): Promise<string> {
          return Promise.resolve('hello');
        },
      });

      const result = await ctx.remote.getAsync();
      assert.strictEqual(result, 'hello');
    });

    void test('promise rejection propagates correctly', async () => {
      await using ctx = await setupService({
        getAsyncError(): Promise<string> {
          return Promise.reject(new Error('async error'));
        },
      });

      await assert.rejects(
        async () => ctx.remote.getAsyncError(),
        (error: Error) => {
          assert.strictEqual(error.message, 'async error');
          return true;
        },
      );
    });

    void test('delayed promise resolves correctly', async () => {
      await using ctx = await setupService({
        delayed(): Promise<number> {
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve(42);
            }, 10);
          });
        },
      });

      const result = await ctx.remote.delayed();
      assert.strictEqual(result, 42);
    });
  });

  void suite('Nested promises with nestedProxies', () => {
    void test('promise in return object property', async () => {
      await using ctx = await setupService(
        {
          getData(): {name: string; value: Promise<number>} {
            return {
              name: 'test',
              value: Promise.resolve(42),
            };
          },
        },
        {nestedProxies: true},
      );

      const data = await ctx.remote.getData();
      assert.strictEqual(data.name, 'test');
      const value = await data.value;
      assert.strictEqual(value, 42);
    });

    void test('promise in return array element', async () => {
      await using ctx = await setupService(
        {
          getArray(): Array<Promise<number>> {
            return [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)];
          },
        },
        {nestedProxies: true},
      );

      const arr = await ctx.remote.getArray();
      const values = await Promise.all(arr);
      assert.deepStrictEqual(values, [1, 2, 3]);
    });

    void test('multiple promises in same object', async () => {
      await using ctx = await setupService(
        {
          getMultiple(): {a: Promise<string>; b: Promise<number>} {
            return {
              a: Promise.resolve('hello'),
              b: Promise.resolve(123),
            };
          },
        },
        {nestedProxies: true},
      );

      const data = await ctx.remote.getMultiple();
      const [a, b] = await Promise.all([data.a, data.b]);
      assert.strictEqual(a, 'hello');
      assert.strictEqual(b, 123);
    });

    void test('deeply nested promises', async () => {
      await using ctx = await setupService(
        {
          getNested(): {outer: {inner: Promise<string>}} {
            return {
              outer: {
                inner: Promise.resolve('deep'),
              },
            };
          },
        },
        {nestedProxies: true},
      );

      const data = await ctx.remote.getNested();
      const value = await data.outer.inner;
      assert.strictEqual(value, 'deep');
    });

    void test('promise rejection in nested object', async () => {
      await using ctx = await setupService(
        {
          getWithError(): {data: Promise<string>} {
            return {
              data: Promise.reject(new Error('nested error')),
            };
          },
        },
        {nestedProxies: true},
      );

      const result = await ctx.remote.getWithError();
      await assert.rejects(
        async () => result.data,
        (error: Error) => {
          assert.strictEqual(error.message, 'nested error');
          return true;
        },
      );
    });
  });

  void suite('Promise as argument', () => {
    void test('promise as argument is proxied and can be awaited by receiver', async () => {
      let wasReceived = false;
      await using ctx = await setupService({
        async receivePromise(promiseValue: Promise<number>): Promise<string> {
          wasReceived = true;
          const value = await promiseValue;
          return `received ${String(value)}`;
        },
      });

      // Pass a promise as argument - it should be proxied
      // The receiver awaits it and gets the resolved value
      const result = await ctx.remote.receivePromise(
        Promise.resolve(42) as unknown as Promise<number>,
      );
      assert.ok(wasReceived);
      assert.strictEqual(result, 'received 42');
    });

    void test('promise rejection in argument propagates to receiver', async () => {
      await using ctx = await setupService({
        async receivePromise(promiseValue: Promise<number>): Promise<string> {
          try {
            await promiseValue;
            return 'no error';
          } catch (e) {
            return `caught: ${(e as Error).message}`;
          }
        },
      });

      const result = await ctx.remote.receivePromise(
        Promise.reject(new Error('arg error')) as unknown as Promise<number>,
      );
      assert.strictEqual(result, 'caught: arg error');
    });
  });

  void suite('Debug mode for promises', () => {
    void test('nested promise in manual mode throws NonCloneableError', async () => {
      await using ctx = await setupService(
        {
          getData(): {value: Promise<number>} {
            return {
              value: Promise.resolve(42),
            };
          },
        },
        {nestedProxies: false, debug: true},
      );

      await assert.rejects(
        async () => ctx.remote.getData(),
        (error: Error) => {
          assert.ok(error.name === 'NonCloneableError');
          assert.ok(error.message.includes('promise'));
          assert.ok(error.message.includes('value'));
          return true;
        },
      );
    });
  });

  void suite('Promise chaining', () => {
    void test('promise resolving to another promise-like value', async () => {
      await using ctx = await setupService({
        getChained(): Promise<{result: string}> {
          return Promise.resolve({result: 'chained'});
        },
      });

      const data = await ctx.remote.getChained();
      assert.strictEqual(data.result, 'chained');
    });

    void test('async method with multiple awaits', async () => {
      await using ctx = await setupService({
        async multiStep(): Promise<number> {
          const a = await Promise.resolve(10);
          const b = await Promise.resolve(20);
          return a + b;
        },
      });

      const result = await ctx.remote.multiStep();
      assert.strictEqual(result, 30);
    });
  });
});
