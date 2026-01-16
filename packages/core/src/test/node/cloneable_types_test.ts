/**
 * Tests for natively cloneable types like Map and Set.
 * These types are supported by the structured clone algorithm and should
 * transfer correctly across the worker boundary.
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';

void suite('cloneable types: Map', () => {
  void test('returns a Map from worker', async () => {
    await using ctx = await setupService({
      getMap(): Map<string, number> {
        return new Map([
          ['a', 1],
          ['b', 2],
          ['c', 3],
        ]);
      },
    });

    const result = await ctx.remote.getMap();
    assert.ok(result instanceof Map);
    assert.strictEqual(result.size, 3);
    assert.strictEqual(result.get('a'), 1);
    assert.strictEqual(result.get('b'), 2);
    assert.strictEqual(result.get('c'), 3);
  });

  void test('sends a Map to worker', async () => {
    await using ctx = await setupService({
      sumMapValues(map: Map<string, number>): number {
        let sum = 0;
        for (const value of map.values()) {
          sum += value;
        }
        return sum;
      },
    });

    const input = new Map([
      ['x', 10],
      ['y', 20],
      ['z', 30],
    ]);
    const result = await ctx.remote.sumMapValues(input);
    assert.strictEqual(result, 60);
  });

  void test('sends a Map to class instance service', async () => {
    class DataService {
      processData(
        name: string,
        data: Map<string, number>,
        multiplier: number,
      ): number {
        assert.ok(
          data instanceof Map,
          `Expected Map but got ${Object.prototype.toString.call(data)}`,
        );
        let sum = 0;
        for (const value of data.values()) {
          sum += value;
        }
        return sum * multiplier;
      }
    }

    await using ctx = await setupService(new DataService());

    const input = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const result = await ctx.remote.processData('test', input, 10);
    assert.strictEqual(result, 60);
  });

  void test('sends a Map as last argument to class method', async () => {
    class ConfigService {
      applyConfig(
        id: number,
        options: {flag: boolean},
        settings: Map<string, string>,
      ): Array<string> {
        assert.ok(
          settings instanceof Map,
          `Expected Map but got ${Object.prototype.toString.call(settings)}`,
        );
        return [...settings.keys()];
      }
    }

    await using ctx = await setupService(new ConfigService());

    const settings = new Map([
      ['theme', 'dark'],
      ['language', 'en'],
    ]);
    const result = await ctx.remote.applyConfig(42, {flag: true}, settings);
    assert.deepStrictEqual(result, ['theme', 'language']);
  });

  void test('sends a Map with nestedProxies enabled', async () => {
    class DataService {
      processData(
        name: string,
        data: Map<string, number>,
        multiplier: number,
      ): number {
        assert.ok(
          data instanceof Map,
          `Expected Map but got ${Object.prototype.toString.call(data)}`,
        );
        let sum = 0;
        for (const value of data.values()) {
          sum += value;
        }
        return sum * multiplier;
      }
    }

    await using ctx = await setupService(new DataService(), {
      nestedProxies: true,
    });

    const input = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const result = await ctx.remote.processData('test', input, 10);
    assert.strictEqual(result, 60);
  });

  void test('sends a Set with nestedProxies enabled', async () => {
    class SetService {
      sumValues(label: string, values: Set<number>): number {
        assert.ok(
          values instanceof Set,
          `Expected Set but got ${Object.prototype.toString.call(values)}`,
        );
        let sum = 0;
        for (const v of values) {
          sum += v;
        }
        return sum;
      }
    }

    await using ctx = await setupService(new SetService(), {
      nestedProxies: true,
    });

    const input = new Set([10, 20, 30]);
    const result = await ctx.remote.sumValues('test', input);
    assert.strictEqual(result, 60);
  });

  void test('round-trips a Map through worker', async () => {
    await using ctx = await setupService({
      processMap(map: Map<string, number>): Map<string, number> {
        const result = new Map<string, number>();
        for (const [key, value] of map) {
          result.set(key.toUpperCase(), value * 2);
        }
        return result;
      },
    });

    const input = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const result = await ctx.remote.processMap(input);

    assert.ok(result instanceof Map);
    assert.strictEqual(result.size, 2);
    assert.strictEqual(result.get('A'), 2);
    assert.strictEqual(result.get('B'), 4);
  });

  void test('empty Map', async () => {
    await using ctx = await setupService({
      getEmptyMap(): Map<string, number> {
        return new Map();
      },
      isMapEmpty(map: Map<string, number>): boolean {
        return map.size === 0;
      },
    });

    const returned = await ctx.remote.getEmptyMap();
    assert.ok(returned instanceof Map);
    assert.strictEqual(returned.size, 0);

    const isEmpty = await ctx.remote.isMapEmpty(new Map());
    assert.strictEqual(isEmpty, true);
  });

  void test('nested Map inside object', async () => {
    interface DataWithMap {
      name: string;
      scores: Map<string, number>;
    }

    await using ctx = await setupService({
      echo(data: DataWithMap): DataWithMap {
        return data;
      },
    });

    const input: DataWithMap = {
      name: 'test',
      scores: new Map([
        ['math', 95],
        ['english', 88],
      ]),
    };

    const result = await ctx.remote.echo(input);
    assert.strictEqual(result.name, 'test');
    assert.ok(result.scores instanceof Map);
    assert.strictEqual(result.scores.get('math'), 95);
    assert.strictEqual(result.scores.get('english'), 88);
  });

  void test('Map with complex values', async () => {
    interface Person {
      name: string;
      age: number;
    }

    await using ctx = await setupService({
      echo<T>(value: T): T {
        return value;
      },
    });

    const input = new Map<string, Person>([
      ['person1', {name: 'Alice', age: 30}],
      ['person2', {name: 'Bob', age: 25}],
    ]);

    const result = await ctx.remote.echo(input);
    assert.ok(result instanceof Map);
    assert.deepStrictEqual(result.get('person1'), {name: 'Alice', age: 30});
    assert.deepStrictEqual(result.get('person2'), {name: 'Bob', age: 25});
  });
});

void suite('cloneable types: Set', () => {
  void test('returns a Set from worker', async () => {
    await using ctx = await setupService({
      getSet(): Set<number> {
        return new Set([1, 2, 3, 4, 5]);
      },
    });

    const result = await ctx.remote.getSet();
    assert.ok(result instanceof Set);
    assert.strictEqual(result.size, 5);
    assert.ok(result.has(1));
    assert.ok(result.has(5));
    assert.ok(!result.has(6));
  });

  void test('sends a Set to worker', async () => {
    await using ctx = await setupService({
      sumSetValues(set: Set<number>): number {
        let sum = 0;
        for (const value of set) {
          sum += value;
        }
        return sum;
      },
    });

    const input = new Set([10, 20, 30]);
    const result = await ctx.remote.sumSetValues(input);
    assert.strictEqual(result, 60);
  });

  void test('round-trips a Set through worker', async () => {
    await using ctx = await setupService({
      doubleValues(set: Set<number>): Set<number> {
        const result = new Set<number>();
        for (const value of set) {
          result.add(value * 2);
        }
        return result;
      },
    });

    const input = new Set([1, 2, 3]);
    const result = await ctx.remote.doubleValues(input);

    assert.ok(result instanceof Set);
    assert.strictEqual(result.size, 3);
    assert.ok(result.has(2));
    assert.ok(result.has(4));
    assert.ok(result.has(6));
  });

  void test('empty Set', async () => {
    await using ctx = await setupService({
      getEmptySet(): Set<number> {
        return new Set();
      },
      isSetEmpty(set: Set<number>): boolean {
        return set.size === 0;
      },
    });

    const returned = await ctx.remote.getEmptySet();
    assert.ok(returned instanceof Set);
    assert.strictEqual(returned.size, 0);

    const isEmpty = await ctx.remote.isSetEmpty(new Set());
    assert.strictEqual(isEmpty, true);
  });

  void test('nested Set inside object', async () => {
    interface DataWithSet {
      name: string;
      tags: Set<string>;
    }

    await using ctx = await setupService({
      echo(data: DataWithSet): DataWithSet {
        return data;
      },
    });

    const input: DataWithSet = {
      name: 'article',
      tags: new Set(['javascript', 'typescript', 'testing']),
    };

    const result = await ctx.remote.echo(input);
    assert.strictEqual(result.name, 'article');
    assert.ok(result.tags instanceof Set);
    assert.strictEqual(result.tags.size, 3);
    assert.ok(result.tags.has('javascript'));
    assert.ok(result.tags.has('typescript'));
    assert.ok(result.tags.has('testing'));
  });

  void test('Set with complex values', async () => {
    // Sets can contain objects (by reference identity)
    await using ctx = await setupService({
      getObjectSet(): Set<{id: number; name: string}> {
        return new Set([
          {id: 1, name: 'one'},
          {id: 2, name: 'two'},
        ]);
      },
    });

    const result = await ctx.remote.getObjectSet();
    assert.ok(result instanceof Set);
    assert.strictEqual(result.size, 2);

    const values = [...result];
    assert.deepStrictEqual(values[0], {id: 1, name: 'one'});
    assert.deepStrictEqual(values[1], {id: 2, name: 'two'});
  });
});

void suite('cloneable types: combined', () => {
  void test('Map containing Sets', async () => {
    await using ctx = await setupService({
      echo<T>(value: T): T {
        return value;
      },
    });

    const input = new Map<string, Set<number>>([
      ['evens', new Set([2, 4, 6])],
      ['odds', new Set([1, 3, 5])],
    ]);

    const result = await ctx.remote.echo(input);
    assert.ok(result instanceof Map);

    const evens = result.get('evens') as Set<number> | undefined;
    assert.ok(evens instanceof Set);
    assert.ok(evens.has(2));
    assert.ok(evens.has(4));
    assert.ok(evens.has(6));

    const odds = result.get('odds') as Set<number> | undefined;
    assert.ok(odds instanceof Set);
    assert.ok(odds.has(1));
    assert.ok(odds.has(3));
    assert.ok(odds.has(5));
  });

  void test('Set containing Maps', async () => {
    // While unusual, Sets can contain Maps
    await using ctx = await setupService({
      getMaps(): Set<Map<string, number>> {
        return new Set([new Map([['a', 1]]), new Map([['b', 2]])]);
      },
    });

    const result = await ctx.remote.getMaps();
    assert.ok(result instanceof Set);
    assert.strictEqual(result.size, 2);

    const maps = [...result];
    assert.ok(maps[0] instanceof Map);
    assert.ok(maps[1] instanceof Map);
  });

  void test('deeply nested cloneable structures', async () => {
    interface ComplexData {
      metadata: Map<string, string>;
      categories: Set<string>;
      nested: {
        lookup: Map<number, Set<string>>;
      };
    }

    await using ctx = await setupService({
      echo(data: ComplexData): ComplexData {
        return data;
      },
    });

    const input: ComplexData = {
      metadata: new Map([
        ['version', '1.0'],
        ['author', 'test'],
      ]),
      categories: new Set(['a', 'b', 'c']),
      nested: {
        lookup: new Map([
          [1, new Set(['one', 'uno'])],
          [2, new Set(['two', 'dos'])],
        ]),
      },
    };

    const result = await ctx.remote.echo(input);

    assert.ok(result.metadata instanceof Map);
    assert.strictEqual(result.metadata.get('version'), '1.0');

    assert.ok(result.categories instanceof Set);
    assert.ok(result.categories.has('a'));

    assert.ok(result.nested.lookup instanceof Map);
    const lookupOne = result.nested.lookup.get(1);
    assert.ok(lookupOne instanceof Set);
    assert.ok(lookupOne.has('one'));
    assert.ok(lookupOne.has('uno'));
  });

  void test('array of Maps and Sets', async () => {
    await using ctx = await setupService({
      echo<T>(value: T): T {
        return value;
      },
    });

    const input = [
      new Map([['key', 'value']]),
      new Set([1, 2, 3]),
      new Map([['another', 'map']]),
    ];

    const result = await ctx.remote.echo(input);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 3);
    assert.ok(result[0] instanceof Map);
    assert.ok(result[1] instanceof Set);
    assert.ok(result[2] instanceof Map);
  });
});

void suite('cloneable types: other built-ins', () => {
  void test('Date objects', async () => {
    await using ctx = await setupService({
      getDate(): Date {
        return new Date('2024-01-15T12:00:00Z');
      },
      addDays(date: Date, days: number): Date {
        const result = new Date(date);
        result.setDate(result.getDate() + days);
        return result;
      },
    });

    const returned = await ctx.remote.getDate();
    assert.ok(returned instanceof Date);
    assert.strictEqual(returned.toISOString(), '2024-01-15T12:00:00.000Z');

    const input = new Date('2024-01-01T00:00:00Z');
    const added = await ctx.remote.addDays(input, 10);
    assert.ok(added instanceof Date);
    assert.strictEqual(added.toISOString(), '2024-01-11T00:00:00.000Z');
  });

  void test('RegExp objects', async () => {
    await using ctx = await setupService({
      getRegex(): RegExp {
        return /hello\s+world/gi;
      },
      testRegex(regex: RegExp, str: string): boolean {
        return regex.test(str);
      },
    });

    const returned = await ctx.remote.getRegex();
    assert.ok(returned instanceof RegExp);
    assert.strictEqual(returned.source, 'hello\\s+world');
    assert.strictEqual(returned.flags, 'gi');

    const matches = await ctx.remote.testRegex(/^\d+$/, '12345');
    assert.strictEqual(matches, true);

    const noMatch = await ctx.remote.testRegex(/^\d+$/, 'abc');
    assert.strictEqual(noMatch, false);
  });

  void test('ArrayBuffer', async () => {
    await using ctx = await setupService({
      createBuffer(): ArrayBuffer {
        const buffer = new ArrayBuffer(4);
        const view = new Uint8Array(buffer);
        view[0] = 1;
        view[1] = 2;
        view[2] = 3;
        view[3] = 4;
        return buffer;
      },
      sumBuffer(buffer: ArrayBuffer): number {
        const view = new Uint8Array(buffer);
        let sum = 0;
        for (const byte of view) {
          sum += byte;
        }
        return sum;
      },
    });

    const returned = await ctx.remote.createBuffer();
    assert.ok(returned instanceof ArrayBuffer);
    assert.strictEqual(returned.byteLength, 4);
    const view = new Uint8Array(returned);
    assert.deepStrictEqual([...view], [1, 2, 3, 4]);

    const input = new ArrayBuffer(3);
    new Uint8Array(input).set([10, 20, 30]);
    const sum = await ctx.remote.sumBuffer(input);
    assert.strictEqual(sum, 60);
  });

  void test('TypedArrays', async () => {
    await using ctx = await setupService({
      getUint8Array(): Uint8Array {
        return new Uint8Array([1, 2, 3, 4, 5]);
      },
      getInt32Array(): Int32Array {
        return new Int32Array([-1, 0, 1, 2]);
      },
      getFloat64Array(): Float64Array {
        return new Float64Array([1.5, 2.5, 3.5]);
      },
      sumUint8(arr: Uint8Array): number {
        return arr.reduce((a, b) => a + b, 0);
      },
    });

    const uint8 = await ctx.remote.getUint8Array();
    assert.ok(uint8 instanceof Uint8Array);
    assert.deepStrictEqual([...uint8], [1, 2, 3, 4, 5]);

    const int32 = await ctx.remote.getInt32Array();
    assert.ok(int32 instanceof Int32Array);
    assert.deepStrictEqual([...int32], [-1, 0, 1, 2]);

    const float64 = await ctx.remote.getFloat64Array();
    assert.ok(float64 instanceof Float64Array);
    assert.deepStrictEqual([...float64], [1.5, 2.5, 3.5]);

    const sum = await ctx.remote.sumUint8(new Uint8Array([5, 10, 15]));
    assert.strictEqual(sum, 30);
  });

  void test('Error objects', async () => {
    await using ctx = await setupService({
      createError(): Error {
        return new Error('test error');
      },
      echoError(error: Error): Error {
        return error;
      },
    });

    const returned = await ctx.remote.createError();
    assert.ok(returned instanceof Error);
    assert.strictEqual(returned.message, 'test error');

    const input = new TypeError('type error');
    const echoed = await ctx.remote.echoError(input);
    assert.ok(echoed instanceof Error);
    assert.strictEqual(echoed.message, 'type error');
    // Note: Error subclass type (TypeError) is preserved by structured clone
    assert.ok(echoed instanceof TypeError);
  });
});
