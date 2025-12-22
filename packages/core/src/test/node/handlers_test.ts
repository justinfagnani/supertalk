/**
 * Tests for the handler system.
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {MessageChannel} from 'node:worker_threads';
import {setupService} from './test-utils.js';
import {
  expose,
  wrap,
  transfer,
  WIRE_TYPE,
  type Handler,
  type ToWireContext,
  type FromWireContext,
} from '../../index.js';
import {streamHandler} from '../../handlers/streams.js';

// Wire types for our test handlers
const MAP_WIRE_TYPE = 'test:map';
const SET_WIRE_TYPE = 'test:set';

interface WireMap {
  [WIRE_TYPE]: typeof MAP_WIRE_TYPE;
  entries: Array<[unknown, unknown]>;
}

interface WireSet {
  [WIRE_TYPE]: typeof SET_WIRE_TYPE;
  values: Array<unknown>;
}

/**
 * A test Map handler that clones Maps by converting to/from arrays.
 */
const mapHandler: Handler<Map<unknown, unknown>, WireMap> = {
  wireType: MAP_WIRE_TYPE,

  canHandle(value: unknown): value is Map<unknown, unknown> {
    return value instanceof Map;
  },

  toWire(map: Map<unknown, unknown>, ctx: ToWireContext): WireMap {
    const entries: Array<[unknown, unknown]> = [];
    for (const [key, val] of map) {
      entries.push([ctx.toWire(key), ctx.toWire(val)]);
    }
    return {
      [WIRE_TYPE]: MAP_WIRE_TYPE,
      entries,
    };
  },

  fromWire(wire: WireMap, ctx: FromWireContext): Map<unknown, unknown> {
    const map = new Map<unknown, unknown>();
    for (const [key, val] of wire.entries) {
      map.set(ctx.fromWire(key), ctx.fromWire(val));
    }
    return map;
  },
};

/**
 * A test Set handler that clones Sets by converting to/from arrays.
 */
const setHandler: Handler<Set<unknown>, WireSet> = {
  wireType: SET_WIRE_TYPE,

  canHandle(value: unknown): value is Set<unknown> {
    return value instanceof Set;
  },

  toWire(set: Set<unknown>, ctx: ToWireContext): WireSet {
    const values: Array<unknown> = [];
    for (const val of set) {
      values.push(ctx.toWire(val));
    }
    return {
      [WIRE_TYPE]: SET_WIRE_TYPE,
      values,
    };
  },

  fromWire(wire: WireSet, ctx: FromWireContext): Set<unknown> {
    const set = new Set<unknown>();
    for (const val of wire.values) {
      set.add(ctx.fromWire(val));
    }
    return set;
  },
};

void suite('Handler system', () => {
  void test('custom Map handler - return value', async () => {
    await using ctx = await setupService(
      {
        getMap(): Map<string, number> {
          return new Map([
            ['a', 1],
            ['b', 2],
            ['c', 3],
          ]);
        },
      },
      {handlers: [mapHandler]},
    );

    const result = await ctx.remote.getMap();
    assert.ok(result instanceof Map, 'Result should be a Map');
    assert.strictEqual(result.size, 3);
    assert.strictEqual(result.get('a'), 1);
    assert.strictEqual(result.get('b'), 2);
    assert.strictEqual(result.get('c'), 3);
  });

  void test('custom Map handler - argument', async () => {
    await using ctx = await setupService(
      {
        sumMap(map: Map<string, number>): number {
          let sum = 0;
          for (const val of map.values()) {
            sum += val;
          }
          return sum;
        },
      },
      {handlers: [mapHandler]},
    );

    const input = new Map([
      ['x', 10],
      ['y', 20],
    ]);
    const result = await ctx.remote.sumMap(input);
    assert.strictEqual(result, 30);
  });

  void test('custom Set handler - return value', async () => {
    await using ctx = await setupService(
      {
        getSet(): Set<string> {
          return new Set(['apple', 'banana', 'cherry']);
        },
      },
      {handlers: [setHandler]},
    );

    const result = await ctx.remote.getSet();
    assert.ok(result instanceof Set, 'Result should be a Set');
    assert.strictEqual(result.size, 3);
    assert.ok(result.has('apple'));
    assert.ok(result.has('banana'));
    assert.ok(result.has('cherry'));
  });

  void test('custom Set handler - argument', async () => {
    await using ctx = await setupService(
      {
        hasItem(set: Set<string>, item: string): boolean {
          return set.has(item);
        },
      },
      {handlers: [setHandler]},
    );

    const input = new Set(['one', 'two', 'three']);
    const hasTwo = await ctx.remote.hasItem(input, 'two');
    const hasFour = await ctx.remote.hasItem(input, 'four');
    assert.strictEqual(hasTwo, true);
    assert.strictEqual(hasFour, false);
  });

  void test('nested handlers - Map containing Sets', async () => {
    await using ctx = await setupService(
      {
        getMapOfSets(): Map<string, Set<number>> {
          return new Map([
            ['evens', new Set([2, 4, 6])],
            ['odds', new Set([1, 3, 5])],
          ]);
        },
      },
      {handlers: [mapHandler, setHandler]},
    );

    const result = await ctx.remote.getMapOfSets();
    assert.ok(result instanceof Map, 'Result should be a Map');
    assert.strictEqual(result.size, 2);

    const evens = result.get('evens');
    assert.ok(evens instanceof Set, 'evens should be a Set');
    assert.ok(evens.has(2));
    assert.ok(evens.has(4));
    assert.ok(evens.has(6));

    const odds = result.get('odds');
    assert.ok(odds instanceof Set, 'odds should be a Set');
    assert.ok(odds.has(1));
    assert.ok(odds.has(3));
    assert.ok(odds.has(5));
  });

  void test('handler with plain objects - Map in object', async () => {
    interface Data {
      name: string;
      scores: Map<string, number>;
    }

    await using ctx = await setupService(
      {
        getData(): Data {
          return {
            name: 'test',
            scores: new Map([
              ['math', 95],
              ['english', 88],
            ]),
          };
        },
      },
      {handlers: [mapHandler]},
    );

    const result = await ctx.remote.getData();
    assert.strictEqual(result.name, 'test');
    assert.ok(result.scores instanceof Map);
    assert.strictEqual(result.scores.get('math'), 95);
    assert.strictEqual(result.scores.get('english'), 88);
  });

  void test('multiple handlers - first match wins', async () => {
    // Create a handler that also matches Maps but returns a different type
    const altMapHandler: Handler<Map<unknown, unknown>, {type: 'alt'}> = {
      wireType: 'alt-map',
      canHandle: (v): v is Map<unknown, unknown> => v instanceof Map,
      toWire: () => ({type: 'alt' as const}),
      fromWire: () => new Map([['from', 'alt']]),
    };

    await using ctx = await setupService(
      {
        getMap(): Map<string, string> {
          return new Map([['original', 'value']]);
        },
      },
      // mapHandler is first, so it should be used
      {handlers: [mapHandler, altMapHandler]},
    );

    const result = await ctx.remote.getMap();
    assert.ok(result instanceof Map);
    // Should have original data, not 'from: alt'
    assert.strictEqual(result.get('original'), 'value');
    assert.strictEqual(result.get('from'), undefined);
  });

  void test('handler only on one side - graceful degradation', async () => {
    // Set up service with handler, but client without handler
    const {port1, port2} = new MessageChannel();

    // Server has the map handler
    expose(
      {
        getMap(): Map<string, number> {
          return new Map([['a', 1]]);
        },
      },
      port1,
      {handlers: [mapHandler]},
    );

    // Client has no handlers - will get raw wire value
    const remote = await wrap<{getMap: () => Map<string, number>}>(port2, {
      handlers: [],
    });

    const result = await remote.getMap();
    // Without the handler, the client receives the wire format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    assert.strictEqual((result as any)[WIRE_TYPE], MAP_WIRE_TYPE);

    port1.close();
    port2.close();
  });
});

void suite('Handler with proxied values', () => {
  void test('Map with proxied function values', async () => {
    await using ctx = await setupService(
      {
        getCallbacks(): Map<string, () => string> {
          return new Map([
            ['greet', () => 'hello'],
            ['farewell', () => 'goodbye'],
          ]);
        },
      },
      {handlers: [mapHandler], nestedProxies: true},
    );

    const callbacks = await ctx.remote.getCallbacks();
    assert.ok(callbacks instanceof Map);

    const greet = callbacks.get('greet');
    assert.ok(typeof greet === 'function', 'greet should be a function proxy');
    const greetResult = await (greet as unknown as () => Promise<string>)();
    assert.strictEqual(greetResult, 'hello');

    const farewell = callbacks.get('farewell');
    assert.ok(
      typeof farewell === 'function',
      'farewell should be a function proxy',
    );
    const farewellResult = await (
      farewell as unknown as () => Promise<string>
    )();
    assert.strictEqual(farewellResult, 'goodbye');
  });
});

void suite('Stream handlers', () => {
  void test('ReadableStream handler - return value', async () => {
    await using ctx = await setupService(
      {
        getStream(): ReadableStream<string> {
          return new ReadableStream({
            start(controller) {
              controller.enqueue('hello');
              controller.enqueue('world');
              controller.close();
            },
          });
        },
      },
      {handlers: [streamHandler]},
    );

    const stream =
      (await ctx.remote.getStream()) as unknown as ReadableStream<string>;
    assert.ok(
      stream instanceof ReadableStream,
      'Result should be a ReadableStream',
    );

    const reader = stream.getReader();
    const chunks: Array<string> = [];
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    assert.deepStrictEqual(chunks, ['hello', 'world']);
  });

  void test('ReadableStream handler - argument', async () => {
    await using ctx = await setupService(
      {
        async consumeStream(
          stream: ReadableStream<string>,
        ): Promise<Array<string>> {
          const reader = stream.getReader();
          const chunks: Array<string> = [];
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          return chunks;
        },
      },
      {handlers: [streamHandler]},
    );

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('a');
        controller.enqueue('b');
        controller.enqueue('c');
        controller.close();
      },
    });

    const result = await ctx.remote.consumeStream(stream);
    assert.deepStrictEqual(result, ['a', 'b', 'c']);
  });

  void test('WritableStream handler - return value', async () => {
    // Service creates a TransformStream, returns writable, keeps readable
    // Client writes to it, then we read from service side to verify
    const transform = new TransformStream<string>();

    await using ctx = await setupService(
      {
        getSink(): WritableStream<string> {
          return transform.writable;
        },

        async collectWrites(): Promise<Array<string>> {
          const reader = transform.readable.getReader();
          const chunks: Array<string> = [];
          for (;;) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const {done, value} = await reader.read();
            if (done) break;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            chunks.push(value);
          }
          return chunks;
        },
      },
      {handlers: [streamHandler]},
    );

    const sink =
      (await ctx.remote.getSink()) as unknown as WritableStream<string>;
    assert.ok(
      sink instanceof WritableStream,
      'Result should be a WritableStream',
    );

    const writer = sink.getWriter();
    await writer.write('one');
    await writer.write('two');
    await writer.close();

    const collected = await ctx.remote.collectWrites();
    assert.deepStrictEqual(collected, ['one', 'two']);
  });

  void test('WritableStream handler - argument', async () => {
    await using ctx = await setupService(
      {
        async writeToSink(sink: WritableStream<string>): Promise<void> {
          const writer = sink.getWriter();
          await writer.write('x');
          await writer.write('y');
          await writer.write('z');
          await writer.close();
        },
      },
      {handlers: [streamHandler]},
    );

    // Client creates a TransformStream, passes writable, keeps readable
    const {readable, writable} = new TransformStream<string>();

    // Start collecting in parallel
    const collectPromise = (async () => {
      const reader = readable.getReader();
      const chunks: Array<string> = [];
      for (;;) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const {done, value} = await reader.read();
        if (done) break;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        chunks.push(value);
      }
      return chunks;
    })();

    await ctx.remote.writeToSink(writable);
    const received = await collectPromise;
    assert.deepStrictEqual(received, ['x', 'y', 'z']);
  });

  void test('TransformStream - bidirectional', async () => {
    await using ctx = await setupService(
      {
        async processStream(
          input: ReadableStream<number>,
          output: WritableStream<number>,
        ): Promise<void> {
          const reader = input.getReader();
          const writer = output.getWriter();
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            await writer.write(value * 2);
          }
          await writer.close();
        },
      },
      {handlers: [streamHandler]},
    );

    // Create input stream
    const inputStream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      },
    });

    // Create output transform to collect results
    const {readable, writable} = new TransformStream<number>();

    // Start collecting in parallel
    const collectPromise = (async () => {
      const reader = readable.getReader();
      const chunks: Array<number> = [];
      for (;;) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const {done, value} = await reader.read();
        if (done) break;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        chunks.push(value);
      }
      return chunks;
    })();

    await ctx.remote.processStream(inputStream, writable);
    const results = await collectPromise;
    assert.deepStrictEqual(results, [2, 4, 6]);
  });
});

void suite('Manual transfer() without handler', () => {
  void test('manually transferred stream works without any handlers', async () => {
    await using ctx = await setupService(
      {
        getStream() {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue('manual');
              controller.enqueue('transfer');
              controller.close();
            },
          });
          return transfer(stream);
        },
      },
      {}, // No handlers!
    );

    const stream =
      (await ctx.remote.getStream()) as unknown as ReadableStream<string>;
    assert.ok(
      stream instanceof ReadableStream,
      'Result should be a ReadableStream',
    );

    const reader = stream.getReader();
    const chunks: Array<string> = [];
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    assert.deepStrictEqual(chunks, ['manual', 'transfer']);
  });

  void test('manually transferred stream works with unrelated handlers', async () => {
    await using ctx = await setupService(
      {
        getStream() {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue('still');
              controller.enqueue('works');
              controller.close();
            },
          });
          return transfer(stream);
        },
      },
      // Has a handler, but not for streams - this triggered the bug
      {handlers: [mapHandler]},
    );

    const stream =
      (await ctx.remote.getStream()) as unknown as ReadableStream<string>;
    assert.ok(
      stream instanceof ReadableStream,
      'Result should be a ReadableStream',
    );

    const reader = stream.getReader();
    const chunks: Array<string> = [];
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    assert.deepStrictEqual(chunks, ['still', 'works']);
  });

  void test('manually transferred stream as argument with unrelated handlers', async () => {
    await using ctx = await setupService(
      {
        async consumeStream(
          stream: ReadableStream<string>,
        ): Promise<Array<string>> {
          const reader = stream.getReader();
          const chunks: Array<string> = [];
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          return chunks;
        },
      },
      {handlers: [mapHandler]},
    );

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('arg');
        controller.enqueue('transfer');
        controller.close();
      },
    });

    const result = await ctx.remote.consumeStream(
      transfer(stream) as unknown as ReadableStream<string>,
    );
    assert.deepStrictEqual(result, ['arg', 'transfer']);
  });
});
