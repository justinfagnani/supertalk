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
import type {Proxied, Remote} from '../../index.js';
import {MessageChannel} from 'node:worker_threads';
import {expose, wrap} from '../../index.js';

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
      // Remote<T> uses Remoted<R> so counter.increment() returns Promise<number>
      const result = await counter.increment();
      assert.strictEqual(result, 1);
    });

    void test('class instance methods maintain state', async () => {
      using ctx = setupService({
        createCounter(name: string, initial: number): Counter {
          return new Counter(name, initial);
        },
      });

      const counter = await ctx.remote.createCounter('test', 10);
      // Remote<T> uses Remoted<R> - all methods become async

      assert.strictEqual(await counter.increment(), 11);
      assert.strictEqual(await counter.increment(), 12);
      assert.strictEqual(await counter.decrement(), 11);
    });

    void test('class instance property access', async () => {
      using ctx = setupService({
        createCounter(name: string): Counter {
          return new Counter(name);
        },
      });

      // Remoted<Counter> makes methods async, but properties stay as-is
      // For property access on proxied classes, use Proxied<T>
      const counter = (await ctx.remote.createCounter(
        'myCounter',
      )) as unknown as Proxied<Counter>;
      // Now property access is correctly typed as Promise<string>
      assert.strictEqual(await counter.name, 'myCounter');
    });

    void test('class instance getter access', async () => {
      using ctx = setupService({
        createCounter(name: string, initial: number): Counter {
          return new Counter(name, initial);
        },
      });

      // Proxied<T> makes both methods and properties async
      const counter = (await ctx.remote.createCounter(
        'test',
        42,
      )) as unknown as Proxied<Counter>;
      // Getter access is correctly typed as Promise<number>
      assert.strictEqual(await counter.count, 42);
    });
  });

  void suite('chained method calls', () => {
    void test('method returning another class instance', async () => {
      using ctx = setupService({
        getDatabase(): Database {
          return new Database();
        },
      });

      // Remoted<Database> correctly types db.collection() as returning
      // Promise<Remoted<Collection>>, which has async methods
      const db = await ctx.remote.getDatabase();
      const users = await db.collection('users');
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Remoted transforms methods
      await users.insert('1', {name: 'Alice'});
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Remoted transforms methods
      await users.insert('2', {name: 'Bob'});

      // eslint-disable-next-line @typescript-eslint/await-thenable -- Remoted transforms methods
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
      const posts = await db.collection('posts');
      // Property access on proxied class needs Proxied<T>
      const proxiedPosts = posts as unknown as Proxied<Collection>;
      assert.strictEqual(await proxiedPosts.name, 'posts');
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
      // Remoted<Counter> makes methods async
      await counter1.increment(); // 101
      await counter1.increment(); // 102
      const result = await counter2.increment(); // 103

      assert.strictEqual(result, 103);
    });
  });

  void suite('ProxiedTypes parameter', () => {
    void test('ProxiedTypes makes specified types fully proxied', async () => {
      // Define a service interface
      interface MyService {
        createCounter(name: string): Counter;
        getData(): {value: number};
      }

      // Implementation
      const service: MyService = {
        createCounter(name: string): Counter {
          return new Counter(name, 10);
        },
        getData(): {value: number} {
          return {value: 42};
        },
      };

      const {port1, port2} = new MessageChannel();
      expose(service, port1);

      // Use Remote with ProxiedTypes to declare Counter as proxied
      // This gives us proper types for property access on Counter
      // Note: wrap() returns Remote<T, []>, we cast to add ProxiedTypes
      const remote = wrap<MyService>(port2) as unknown as Remote<
        MyService,
        [Counter]
      >;

      try {
        // Counter is in ProxiedTypes, so it gets Proxied treatment
        const counter = await remote.createCounter('test');
        // Properties are typed as Promise<T>
        assert.strictEqual(await counter.name, 'test');
        // Methods are typed as () => Promise<T>
        assert.strictEqual(await counter.increment(), 11);

        // getData returns a plain object, NOT in ProxiedTypes
        // Properties stay as-is (not Promise<T>)
        const data = await remote.getData();
        assert.strictEqual(data.value, 42); // Not awaited - it's just number
      } finally {
        port1.close();
        port2.close();
      }
    });

    void test('ExcludedTypes prevents proxification of matching types', async () => {
      // Scenario: We have Widget as an interface, but sometimes we return
      // a plain object that happens to match the interface (not proxied)
      // and sometimes we return a class instance (actually proxied).

      // We use ProxiedTypes for the proxied class, and ExcludedTypes
      // for a more specific interface that should NOT be proxied.

      interface WidgetData {
        id: number;
        name: string;
      }

      // Service returns different things
      interface MyService {
        // Returns a class instance - should be proxied
        createCounter(name: string): Counter;
        // Returns plain data - matches Counter's 'name' property structurally
        // but should NOT be treated as proxied
        getWidgetData(): WidgetData;
      }

      const service: MyService = {
        createCounter(name: string): Counter {
          return new Counter(name, 10);
        },
        getWidgetData(): WidgetData {
          return {id: 1, name: 'widget1'};
        },
      };

      const {port1, port2} = new MessageChannel();
      expose(service, port1);

      // Without ExcludedTypes, WidgetData would match Counter due to
      // structural typing (both have 'name: string'). With ExcludedTypes,
      // we can be explicit that WidgetData is plain data.
      const remote = wrap<MyService>(port2) as unknown as Remote<
        MyService,
        [Counter],
        [WidgetData]
      >;

      try {
        // Counter is proxied - properties are Promise<T>
        const counter = await remote.createCounter('test');
        assert.strictEqual(await counter.name, 'test');

        // WidgetData is excluded - properties stay as-is
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
