import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {MessageChannel} from 'node:worker_threads';
import {VERSION, expose, wrap} from '../../index.js';

void suite('@supertalk/core', () => {
  void test('should export VERSION', () => {
    assert.strictEqual(typeof VERSION, 'string');
    assert.ok(VERSION.length > 0);
  });
});

void suite('expose and wrap', () => {
  void test('basic method call', async () => {
    const {port1, port2} = new MessageChannel();

    const service = {
      add(a: number, b: number): number {
        return a + b;
      },
    };

    expose(service, port1);
    const proxy = wrap<typeof service>(port2);

    const result = await proxy.add(2, 3);
    assert.strictEqual(result, 5);

    port1.close();
    port2.close();
  });

  void test('async method call', async () => {
    const {port1, port2} = new MessageChannel();

    const service = {
      async fetchValue(): Promise<string> {
        return 'hello';
      },
    };

    expose(service, port1);
    const proxy = wrap<typeof service>(port2);

    const result = await proxy.fetchValue();
    assert.strictEqual(result, 'hello');

    port1.close();
    port2.close();
  });

  void test('multiple concurrent calls', async () => {
    const {port1, port2} = new MessageChannel();

    const service = {
      async delay(ms: number, value: string): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return value;
      },
    };

    expose(service, port1);
    const proxy = wrap<typeof service>(port2);

    // Fire off multiple calls concurrently
    const results = await Promise.all([
      proxy.delay(30, 'first'),
      proxy.delay(10, 'second'),
      proxy.delay(20, 'third'),
    ]);

    assert.deepStrictEqual(results, ['first', 'second', 'third']);

    port1.close();
    port2.close();
  });

  void test('error propagation', async () => {
    const {port1, port2} = new MessageChannel();

    const service = {
      throwError(): never {
        throw new Error('test error');
      },
    };

    expose(service, port1);
    const proxy = wrap<typeof service>(port2);

    await assert.rejects(
      async () => proxy.throwError(),
      (error: Error) => {
        assert.strictEqual(error.message, 'test error');
        return true;
      },
    );

    port1.close();
    port2.close();
  });

  void test('calling non-existent method', async () => {
    const {port1, port2} = new MessageChannel();

    const service = {
      exists(): string {
        return 'yes';
      },
    };

    expose(service, port1);
    // Cast to add a fake method that doesn't exist
    const proxy = wrap<typeof service & {notExists: () => string}>(port2);

    await assert.rejects(
      async () => proxy.notExists(),
      (error: Error) => {
        assert.ok(error.message.includes('notExists'));
        return true;
      },
    );

    port1.close();
    port2.close();
  });

  void test('class instance methods', async () => {
    const {port1, port2} = new MessageChannel();

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

    const service = new Calculator(10);
    expose(service, port1);
    const proxy = wrap<Calculator>(port2);

    assert.strictEqual(await proxy.add(5), 15);
    assert.strictEqual(await proxy.multiply(3), 30);

    port1.close();
    port2.close();
  });
});
