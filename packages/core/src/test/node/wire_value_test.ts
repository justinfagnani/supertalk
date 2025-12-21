/**
 * Tests for wire value serialization edge cases.
 *
 * @packageDocumentation
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';

void suite('wire value edge cases', () => {
  void test('user object with type property should not confuse wire protocol', async () => {
    // This tests that user objects with a "type" property don't get
    // misinterpreted as wire protocol messages
    using ctx = setupService({
      echo<T>(value: T): T {
        return value;
      },
    });

    // Object that looks like a wire value with type: 'proxy'
    const maliciousProxy = {type: 'proxy', proxyId: 999};
    const result1 = await ctx.remote.echo(maliciousProxy);
    assert.deepStrictEqual(result1, maliciousProxy);

    // Object that looks like a wire value with type: 'promise'
    const maliciousPromise = {type: 'promise', promiseId: 999};
    const result2 = await ctx.remote.echo(maliciousPromise);
    assert.deepStrictEqual(result2, maliciousPromise);

    // Object that looks like a wire value with type: 'raw'
    const maliciousRaw = {type: 'raw', value: 'gotcha'};
    const result3 = await ctx.remote.echo(maliciousRaw);
    assert.deepStrictEqual(result3, maliciousRaw);

    // Object that looks like a wire value with type: 'thrown'
    const maliciousThrown = {
      type: 'thrown',
      error: {name: 'Error', message: 'fake'},
    };
    const result4 = await ctx.remote.echo(maliciousThrown);
    assert.deepStrictEqual(result4, maliciousThrown);

    // Object that looks like a wire value with type: 'proxy-property'
    const maliciousProxyProp = {
      type: 'proxy-property',
      targetProxyId: 999,
      property: 'foo',
    };
    const result5 = await ctx.remote.echo(maliciousProxyProp);
    assert.deepStrictEqual(result5, maliciousProxyProp);
  });

  void test('user object with supertalk-like properties should not confuse markers', async () => {
    // This tests that nested markers require the correct type AND payload property
    using ctx = setupService({
      echo<T>(value: T): T {
        return value;
      },
    });

    // Has the type but wrong payload property name
    const fakeProxyMarker = {
      __supertalk_type__: 'proxy',
      __supertalk_proxy_id__: 999, // wrong property name (should be proxyId)
    };
    const result1 = await ctx.remote.echo(fakeProxyMarker);
    assert.deepStrictEqual(result1, fakeProxyMarker);

    // Has the type but wrong payload property name
    const fakePromiseMarker = {
      __supertalk_type__: 'promise',
      __supertalk_promise_id__: 999, // wrong property name (should be promiseId)
    };
    const result2 = await ctx.remote.echo(fakePromiseMarker);
    assert.deepStrictEqual(result2, fakePromiseMarker);

    // Old-style markers should also be passed through
    const oldStyleProxy = {__supertalk_proxy__: 999};
    const result3 = await ctx.remote.echo(oldStyleProxy);
    assert.deepStrictEqual(result3, oldStyleProxy);

    const oldStylePromise = {__supertalk_promise__: 999};
    const result4 = await ctx.remote.echo(oldStylePromise);
    assert.deepStrictEqual(result4, oldStylePromise);
  });

  void test('nested user objects with type properties', async () => {
    using ctx = setupService({
      echo<T>(value: T): T {
        return value;
      },
    });

    // Nested objects with type properties
    const nested = {
      items: [
        {type: 'proxy', proxyId: 1},
        {type: 'promise', promiseId: 2},
      ],
      child: {
        type: 'raw',
        value: 'nested',
      },
    };

    const result = await ctx.remote.echo(nested);
    assert.deepStrictEqual(result, nested);
  });
});
