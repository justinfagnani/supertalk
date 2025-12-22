/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';
import {proxy} from '../../index.js';
import type {LocalProxy} from '../../index.js';

/**
 * Tests for proxy round-tripping behavior.
 *
 * When a remote proxy is passed back as an argument to the other side,
 * we should detect it and send the original proxy ID rather than creating
 * a new proxy. This avoids double-proxying and allows the receiving side
 * to unwrap it back to the original object.
 */
void suite('Proxy round-trip', () => {
  void suite('Function proxies', () => {
    void test('callback returned back to caller is same function', async () => {
      let capturedCallback: (() => string) | undefined;

      await using ctx = await setupService({
        registerCallback(cb: () => string): void {
          capturedCallback = cb;
        },
        invokeCallback(): string | undefined {
          return capturedCallback?.();
        },
        getCallback(): (() => string) | undefined {
          return capturedCallback;
        },
      });

      // Create a callback on the wrap side
      const myCallback = () => 'hello from callback';

      // Send callback to expose side
      await ctx.remote.registerCallback(myCallback);

      // Get callback back from expose side
      const returnedCallback = await ctx.remote.getCallback();

      // The returned callback should work - when invoked, it calls
      // back to the original function on the wrap side
      assert.ok(returnedCallback);
      // Remoted makes the callback return Promise<string>
      const result = await returnedCallback();
      assert.strictEqual(result, 'hello from callback');
    });

    void test('invoke registered callback', async () => {
      let capturedCallback: (() => string) | undefined;

      await using ctx = await setupService({
        registerCallback(cb: () => string): void {
          capturedCallback = cb;
        },
        invokeCallback(): string | undefined {
          return capturedCallback?.();
        },
      });

      const myCallback = () => 'invoked!';
      await ctx.remote.registerCallback(myCallback);

      // When expose side invokes the callback, it should call back
      // to the original function
      const result = await ctx.remote.invokeCallback();
      assert.strictEqual(result, 'invoked!');
    });
  });

  void suite('Object proxies', () => {
    void test('proxied object returned back to caller maintains identity', async () => {
      // Track what objects were received
      const receivedObjects: Array<object> = [];

      class Handler {
        data = 'handler data';

        process(input: string): string {
          return `processed: ${input}`;
        }
      }

      await using ctx = await setupService(
        {
          createHandler(): LocalProxy<Handler> {
            return proxy(new Handler());
          },
          // When a RemoteProxy<Handler> is sent back, it's unwrapped to Handler
          receiveHandler(handler: Handler | object): void {
            receivedObjects.push(handler);
          },
        },
        {nestedProxies: true},
      );

      // Get a handler proxy from expose side
      const handler = await ctx.remote.createHandler();
      assert.ok(handler);

      // Verify it works - Remoted makes process() return Promise
      const result = await handler.process('test');
      assert.strictEqual(result, 'processed: test');

      // Send it back to expose side
      await ctx.remote.receiveHandler(handler);

      // The expose side should receive the original Handler instance,
      // not a proxy to a proxy
      assert.strictEqual(receivedObjects.length, 1);
      const handler0 = receivedObjects[0];
      assert.ok(handler0 instanceof Handler);
      assert.strictEqual(handler0.data, 'handler data');
    });

    void test('deeply nested proxy round-trip with nestedProxies', async () => {
      class Inner {
        value = 42;

        getValue(): number {
          return this.value;
        }
      }

      // Track received objects
      const receivedInners: Array<Inner> = [];

      await using ctx = await setupService(
        {
          getWrapper(): {inner: LocalProxy<Inner>} {
            // Use proxy() to explicitly mark the class instance
            return {inner: proxy(new Inner())};
          },
          receiveInner(inner: Inner): void {
            receivedInners.push(inner);
          },
        },
        {nestedProxies: true},
      );

      // Get nested structure - inner should be a proxy
      const wrapper = await ctx.remote.getWrapper();
      const innerProxy = wrapper.inner;

      // Verify the proxy works - Remoted makes getValue() return Promise
      const value = await innerProxy.getValue();
      assert.strictEqual(value, 42);

      // Send the inner proxy back - it will be unwrapped to the original Inner
      // Cast needed because innerProxy is RemoteProxy<Inner> but the remote
      // side expects Inner (the proxy gets unwrapped on round-trip)
      await ctx.remote.receiveInner(innerProxy as unknown as Inner);

      // Should receive the original Inner instance
      assert.strictEqual(receivedInners.length, 1);
      assert.ok(receivedInners[0] instanceof Inner);
      const inner0 = receivedInners[0];
      assert.strictEqual(inner0.value, 42);
    });
  });

  void suite('Edge cases', () => {
    void test('multiple callbacks maintain distinct identities', async () => {
      const capturedCallbacks = new Map<string, () => string>();

      await using ctx = await setupService({
        register(name: string, cb: () => string): void {
          capturedCallbacks.set(name, cb);
        },
        invoke(name: string): string | undefined {
          return capturedCallbacks.get(name)?.();
        },
      });

      // Register multiple callbacks
      await ctx.remote.register('first', () => 'I am first');
      await ctx.remote.register('second', () => 'I am second');

      // Each should invoke correctly
      assert.strictEqual(await ctx.remote.invoke('first'), 'I am first');
      assert.strictEqual(await ctx.remote.invoke('second'), 'I am second');
    });

    void test('callback that returns proxied object', async () => {
      class Result {
        constructor(public value: number) {}

        double(): number {
          return this.value * 2;
        }
      }

      let capturedCallback: (() => LocalProxy<Result>) | undefined;

      await using ctx = await setupService(
        {
          setCallback(cb: () => LocalProxy<Result>): void {
            capturedCallback = cb;
          },
          invokeCallback(): LocalProxy<Result> | undefined {
            return capturedCallback?.();
          },
        },
        {nestedProxies: true},
      );

      // Set a callback that returns a class instance wrapped in proxy()
      await ctx.remote.setCallback(() => proxy(new Result(21)));

      // Invoke and use the result - Remoted makes double() return Promise
      const result = await ctx.remote.invokeCallback();
      assert.ok(result);
      const doubled = await result.double();
      assert.strictEqual(doubled, 42);
    });
  });

  void suite('Proxy property round-trip', () => {
    void test('unawaited proxy property passed back resolves to field value', async () => {
      // This tests a specific scenario:
      // 1. Client gets a proxied class instance
      // 2. Client accesses a property (proxy.field) which returns a proxy property
      // 3. Client passes that proxy property back to the remote WITHOUT awaiting
      // 4. Remote receives the actual field value (not a proxy)
      //
      // Proxy properties are branded with metadata containing the target proxy ID
      // and property name. When sent across the wire, the receiving side looks up
      // the target in its localObjects and accesses the property synchronously.

      let receivedValue: unknown;

      class Data {
        field = 'the value';

        getField(): string {
          return this.field;
        }
      }

      await using ctx = await setupService({
        getData(): Data {
          return new Data();
        },
        receiveValue(value: unknown): void {
          receivedValue = value;
        },
      });

      // Get a proxy to the Data instance
      const data = await ctx.remote.getData();

      // Access the field - this returns a proxy property
      // (a function with a .then method, branded with metadata)
      const fieldAccess = data.field;

      // Pass it back to the remote WITHOUT awaiting
      // The proxy property is detected and resolved to the field value
      await ctx.remote.receiveValue(fieldAccess);

      // Remote receives the actual field value, not a proxy
      assert.strictEqual(receivedValue, 'the value');
    });

    void test('awaited proxy property can be passed back', async () => {
      // If you await the field first, then pass it, it should work
      let receivedValue: unknown;

      class Data {
        field = 'the value';
      }

      await using ctx = await setupService({
        getData(): Data {
          return new Data();
        },
        receiveValue(value: unknown): void {
          receivedValue = value;
        },
      });

      const data = await ctx.remote.getData();

      // Await the field access first
      // eslint-disable-next-line @typescript-eslint/await-thenable -- proxy property is thenable at runtime
      const fieldValue = await data.field;

      // Now pass the resolved value
      await ctx.remote.receiveValue(fieldValue);

      assert.strictEqual(receivedValue, 'the value');
    });
  });
});
