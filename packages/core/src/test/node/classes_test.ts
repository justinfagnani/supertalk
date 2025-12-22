/**
 * Tests for class instance proxying with explicit proxy() marker.
 *
 * Class instances require explicit proxy() because:
 * - TypeScript can't express the type transformation without it
 * - It's explicit about intent (proxied vs cloned)
 * - Class instances passed to structured clone lose their prototype
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';
import type {RemoteProxy, LocalProxy} from '../../index.js';
import {MessageChannel} from 'node:worker_threads';
import {expose, wrap, proxy} from '../../index.js';

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

  collection(name: string): LocalProxy<Collection> {
    let coll = this.#collections.get(name);
    if (!coll) {
      coll = new Collection(name);
      this.#collections.set(name, coll);
    }
    return proxy(coll);
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
      await using ctx = await setupService({
        createCounter(name: string): LocalProxy<Counter> {
          return proxy(new Counter(name));
        },
      });

      const counter = await ctx.remote.createCounter('test');
      // Counter is proxied, not cloned - we can call methods on it
      // Remote<T> uses Remoted<R> so counter.increment() returns Promise<number>
      const result = await counter.increment();
      assert.strictEqual(result, 1);
    });

    void test('class instance methods maintain state', async () => {
      await using ctx = await setupService({
        createCounter(name: string, initial: number): LocalProxy<Counter> {
          return proxy(new Counter(name, initial));
        },
      });

      const counter = await ctx.remote.createCounter('test', 10);
      // Remote<T> uses Remoted<R> - all methods become async

      assert.strictEqual(await counter.increment(), 11);
      assert.strictEqual(await counter.increment(), 12);
      assert.strictEqual(await counter.decrement(), 11);
    });

    void test('class instance property access', async () => {
      await using ctx = await setupService({
        createCounter(name: string): LocalProxy<Counter> {
          return proxy(new Counter(name));
        },
      });

      // Remoted<Counter> makes methods async, but properties stay as-is
      // For property access on proxied classes, use RemoteProxy<T>
      const counter = (await ctx.remote.createCounter(
        'myCounter',
      )) as unknown as RemoteProxy<Counter>;
      // Now property access is correctly typed as Promise<string>
      assert.strictEqual(await counter.name, 'myCounter');
    });

    void test('class instance getter access', async () => {
      await using ctx = await setupService({
        createCounter(name: string, initial: number): LocalProxy<Counter> {
          return proxy(new Counter(name, initial));
        },
      });

      // RemoteProxy<T> makes both methods and properties async
      const counter = (await ctx.remote.createCounter(
        'test',
        42,
      )) as unknown as RemoteProxy<Counter>;
      // Getter access is correctly typed as Promise<number>
      assert.strictEqual(await counter.count, 42);
    });
  });

  void suite('chained method calls', () => {
    void test('method returning another class instance', async () => {
      await using ctx = await setupService({
        getDatabase(): LocalProxy<Database> {
          return proxy(new Database());
        },
      });

      // getDatabase returns RemoteProxy<Database>
      // db.collection() returns Promise<RemoteProxy<Collection>>
      const db = await ctx.remote.getDatabase();
      const users = await db.collection('users');
      await users.insert('1', {name: 'Alice'});
      await users.insert('2', {name: 'Bob'});

      assert.strictEqual(await users.count(), 2);
      assert.deepStrictEqual(await users.find('1'), {name: 'Alice'});
    });

    void test('deeply nested class instances', async () => {
      await using ctx = await setupService({
        getDatabase(): LocalProxy<Database> {
          return proxy(new Database());
        },
      });

      const db = await ctx.remote.getDatabase();
      const posts = await db.collection('posts');
      // Property access on proxied class needs RemoteProxy<T>
      const proxiedPosts = posts as unknown as RemoteProxy<Collection>;
      assert.strictEqual(await proxiedPosts.name, 'posts');
    });
  });

  void suite('class identity', () => {
    void test('same instance returned multiple times is same proxy', async () => {
      const sharedCounter = new Counter('shared', 100);

      await using ctx = await setupService({
        getCounter(): LocalProxy<Counter> {
          return proxy(sharedCounter);
        },
      });

      // Get the counter twice
      const counter1 = await ctx.remote.getCounter();
      const counter2 = await ctx.remote.getCounter();

      // Both should reference the same remote object
      // Incrementing via counter1 should be visible via counter2
      // Remoted<Counter> makes methods async
      await counter1.increment(); // 101
      await counter1.increment(); // 102
      const result = await counter2.increment(); // 103

      assert.strictEqual(result, 103);
    });
  });

  void suite('explicit proxy() marker', () => {
    void test('proxy() marks values for explicit proxying', async () => {
      // Define a service that uses proxy() for explicit type-safe proxying
      interface MyService {
        createCounter(name: string): LocalProxy<Counter>;
        getData(): {value: number};
      }

      // Implementation uses proxy() to mark class instances
      const service: MyService = {
        createCounter(name: string): LocalProxy<Counter> {
          return proxy(new Counter(name, 10));
        },
        getData(): {value: number} {
          return {value: 42};
        },
      };

      const {port1, port2} = new MessageChannel();
      expose(service, port1);

      // wrap() returns Remote<MyService> which transforms:
      // - LocalProxy<Counter> → RemoteProxy<Counter> (all access async)
      // - {value: number} → {value: number} (plain object, cloned)
      const remote = await wrap<MyService>(port2);

      try {
        // Counter is explicitly proxied via proxy() - RemoteProxy<Counter>
        const counter = await remote.createCounter('test');
        // Properties are typed as Promise<T>
        assert.strictEqual(await counter.name, 'test');
        // Methods are typed as () => Promise<T>
        assert.strictEqual(await counter.increment(), 11);

        // getData returns a plain object, NOT wrapped with proxy()
        // Properties stay as-is (not Promise<T>)
        const data = await remote.getData();
        assert.strictEqual(data.value, 42); // Not awaited - it's just number
      } finally {
        port1.close();
        port2.close();
      }
    });

    void test('proxy() value property gives access to wrapped object', () => {
      const counter = new Counter('test', 5);
      const wrapped = proxy(counter);

      // LocalProxy has a .value property to access the underlying object
      assert.strictEqual(wrapped.value.name, 'test');
      assert.strictEqual(wrapped.value.increment(), 6);
      assert.strictEqual(wrapped.value.count, 6);
    });

    void test('plain objects vs proxied objects have different types', async () => {
      // This test demonstrates how proxy() disambiguates the types
      // that were previously ambiguous due to structural typing

      interface WidgetData {
        id: number;
        name: string;
      }

      // Service with clearly typed returns
      interface MyService {
        // Returns a proxied class instance
        createCounter(name: string): LocalProxy<Counter>;
        // Returns plain data (cloned)
        getWidgetData(): WidgetData;
      }

      const service: MyService = {
        createCounter(name: string): LocalProxy<Counter> {
          return proxy(new Counter(name, 10));
        },
        getWidgetData(): WidgetData {
          return {id: 1, name: 'widget1'};
        },
      };

      const {port1, port2} = new MessageChannel();
      expose(service, port1);

      const remote = await wrap<MyService>(port2);

      try {
        // Counter is proxied - RemoteProxy<Counter>
        const counter = await remote.createCounter('test');
        assert.strictEqual(await counter.name, 'test');

        // WidgetData is plain object - properties are NOT promises
        const data = await remote.getWidgetData();
        assert.strictEqual(data.id, 1); // Not awaited
        assert.strictEqual(data.name, 'widget1'); // Not awaited
      } finally {
        port1.close();
        port2.close();
      }
    });
  });
});
