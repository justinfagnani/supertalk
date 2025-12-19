import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {VERSION} from '../../index.js';
import {setupService} from './test-utils.js';

void suite('@supertalk/core', () => {
  void test('should export VERSION', () => {
    assert.strictEqual(typeof VERSION, 'string');
    assert.ok(VERSION.length > 0);
  });
});

void suite('expose and wrap', () => {
  void test('basic method call', async () => {
    using ctx = setupService({
      add(a: number, b: number): number {
        return a + b;
      },
    });

    const result = await ctx.remote.add(2, 3);
    assert.strictEqual(result, 5);
  });

  void test('async method call', async () => {
    using ctx = setupService({
      fetchValue(): Promise<string> {
        return Promise.resolve('hello');
      },
    });

    const result = await ctx.remote.fetchValue();
    assert.strictEqual(result, 'hello');
  });

  void test('multiple concurrent calls', async () => {
    using ctx = setupService({
      async delay(ms: number, value: string): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return value;
      },
    });

    // Fire off multiple calls concurrently
    const results = await Promise.all([
      ctx.remote.delay(30, 'first'),
      ctx.remote.delay(10, 'second'),
      ctx.remote.delay(20, 'third'),
    ]);

    assert.deepStrictEqual(results, ['first', 'second', 'third']);
  });

  void test('error propagation', async () => {
    using ctx = setupService({
      throwError(): never {
        throw new Error('test error');
      },
    });

    await assert.rejects(
      async () => ctx.remote.throwError(),
      (error: Error) => {
        assert.strictEqual(error.message, 'test error');
        return true;
      },
    );
  });

  void test('calling non-existent method', async () => {
    const service = {
      exists(): string {
        return 'yes';
      },
    };

    using ctx = setupService(service);
    // Cast to add a fake method that doesn't exist
    const proxy = ctx.remote as typeof ctx.remote & {
      notExists: () => Promise<string>;
    };

    await assert.rejects(
      async () => proxy.notExists(),
      (error: Error) => {
        assert.ok(error.message.includes('notExists'));
        return true;
      },
    );
  });

  void test('class instance methods', async () => {
    class Calculator {
      #base: number;

      constructor(base: number) {
        this.#base = base;
      }

      add(n: number): number {
        return this.#base + n;
      }

      multiply(n: number): number {
        return this.#base * n;
      }
    }

    using ctx = setupService(new Calculator(10));

    assert.strictEqual(await ctx.remote.add(5), 15);
    assert.strictEqual(await ctx.remote.multiply(3), 30);
  });
});
