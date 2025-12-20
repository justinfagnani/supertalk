/**
 * Tests for class instance proxying.
 *
 * Class instances are proxied (not cloned) because they:
 * - Have identity
 * - Have methods that need to execute in their original context
 * - May have internal state (#private fields, closures)
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';

class Counter {
  #count = 0;
  name: string;

  constructor(name: string, initial = 0) {
    this.name = name;
    this.#count = initial;
  }

  increment(): number {
    return ++this.#count;
  }

  decrement(): number {
    return --this.#count;
  }

  get count(): number {
    return this.#count;
  }
}

class Database {
  #collections = new Map<string, Collection>();

  collection(name: string): Collection {
    let coll = this.#collections.get(name);
    if (!coll) {
      coll = new Collection(name);
      this.#collections.set(name, coll);
    }
    return coll;
  }
}

class Collection {
  #name: string;
  #docs = new Map<string, unknown>();

  constructor(name: string) {
    this.#name = name;
  }

  get name(): string {
    return this.#name;
  }

  insert(id: string, doc: unknown): void {
    this.#docs.set(id, doc);
  }

  find(id: string): unknown {
    return this.#docs.get(id);
  }

  count(): number {
    return this.#docs.size;
  }
}

void suite('class instance proxying', () => {
  void suite('basic class instances', () => {
    void test('returned class instance is proxied', async () => {
      using ctx = setupService({
        createCounter(name: string): Counter {
          return new Counter(name);
        },
      });

      const counter = await ctx.remote.createCounter('test');
      // Counter is proxied, not cloned - we can call methods on it
      // eslint-disable-next-line @typescript-eslint/await-thenable
      const result = await (counter as unknown as Counter).increment();
      assert.strictEqual(result, 1);
    });

    void test('class instance methods maintain state', async () => {
      using ctx = setupService({
        createCounter(name: string, initial: number): Counter {
          return new Counter(name, initial);
        },
      });

      const counter = await ctx.remote.createCounter('test', 10);
      const c = counter as unknown as {
        increment(): Promise<number>;
        decrement(): Promise<number>;
      };

      assert.strictEqual(await c.increment(), 11);
      assert.strictEqual(await c.increment(), 12);
      assert.strictEqual(await c.decrement(), 11);
    });

    void test('class instance property access', async () => {
      using ctx = setupService({
        createCounter(name: string): Counter {
          return new Counter(name);
        },
      });

      const counter = await ctx.remote.createCounter('myCounter');
      // Property access should also work via proxy
      // TODO: This requires the "proxy property" pattern
      const c = counter as unknown as {name: Promise<string>};
      assert.strictEqual(await c.name, 'myCounter');
    });

    void test('class instance getter access', async () => {
      using ctx = setupService({
        createCounter(name: string, initial: number): Counter {
          return new Counter(name, initial);
        },
      });

      const counter = await ctx.remote.createCounter('test', 42);
      // Getter should work like property access
      const c = counter as unknown as {count: Promise<number>};
      assert.strictEqual(await c.count, 42);
    });
  });

  void suite('chained method calls', () => {
    void test('method returning another class instance', async () => {
      using ctx = setupService({
        getDatabase(): Database {
          return new Database();
        },
      });

      const db = await ctx.remote.getDatabase();
      const typedDb = db as unknown as {
        collection(name: string): Promise<{
          insert(id: string, doc: unknown): Promise<void>;
          find(id: string): Promise<unknown>;
          count(): Promise<number>;
        }>;
      };

      const users = await typedDb.collection('users');
      await users.insert('1', {name: 'Alice'});
      await users.insert('2', {name: 'Bob'});

      assert.strictEqual(await users.count(), 2);
      assert.deepStrictEqual(await users.find('1'), {name: 'Alice'});
    });

    void test('deeply nested class instances', async () => {
      using ctx = setupService({
        getDatabase(): Database {
          return new Database();
        },
      });

      const db = await ctx.remote.getDatabase();
      const typedDb = db as unknown as {
        collection(name: string): Promise<{name: Promise<string>}>;
      };

      const posts = await typedDb.collection('posts');
      // Property on nested class instance
      assert.strictEqual(await posts.name, 'posts');
    });
  });

  void suite('class identity', () => {
    void test('same instance returned multiple times is same proxy', async () => {
      const sharedCounter = new Counter('shared', 100);

      using ctx = setupService({
        getCounter(): Counter {
          return sharedCounter;
        },
      });

      // Get the counter twice
      const counter1 = await ctx.remote.getCounter();
      const counter2 = await ctx.remote.getCounter();

      // Both should reference the same remote object
      // Incrementing via counter1 should be visible via counter2
      const c1 = counter1 as unknown as {increment(): Promise<number>};
      const c2 = counter2 as unknown as {
        increment(): Promise<number>;
        count: Promise<number>;
      };

      await c1.increment(); // 101
      await c1.increment(); // 102
      const result = await c2.increment(); // 103

      assert.strictEqual(result, 103);
    });
  });
});
