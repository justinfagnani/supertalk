/**
 * Tests for handle() functionality.
 *
 * This file tests opaque handle passing:
 * - Basic handle creation and passing
 * - Handle caching (same object = same handle)
 * - Handles stay as handles (no auto-unwrapping)
 * - getHandleValue() for explicit dereferencing
 * - Handles work in both shallow and nested modes
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';
import {handle, getHandleValue, proxy, getProxyValue} from '../../index.js';
import type {Handle, AsyncProxy} from '../../index.js';

// A simple class for testing
class Token {
  #id: string;

  constructor(id: string) {
    this.#id = id;
  }

  getId(): string {
    return this.#id;
  }
}

void suite('handle() - shallow mode', () => {
  void test('server-created handle can be passed back and dereferenced', async () => {
    await using ctx = await setupService({
      createToken(id: string): Handle<Token> {
        return handle(new Token(id));
      },
      validateToken(tokenHandle: Handle<Token>): string {
        // Dereference the handle on the side that owns it
        const token = getHandleValue(tokenHandle);
        return `Valid: ${token.getId()}`;
      },
    });

    // Server creates the handle
    const tokenHandle = await ctx.remote.createToken('abc123');
    // Client passes it back to server for validation
    const result = await ctx.remote.validateToken(tokenHandle);
    assert.strictEqual(result, 'Valid: abc123');
  });

  void test('handle can be returned from method', async () => {
    await using ctx = await setupService({
      createToken(): Handle<Token> {
        return handle(new Token('xyz789'));
      },
      validateToken(tokenHandle: Handle<Token>): string {
        const token = getHandleValue(tokenHandle);
        return `Valid: ${token.getId()}`;
      },
    });

    // Receive an opaque handle
    const tokenHandle = await ctx.remote.createToken();
    // Handle is a plain object (not a JS Proxy) - no method/property access
    assert.strictEqual(typeof tokenHandle, 'object');
    // Accessing properties returns undefined (no Proxy traps)
    assert.strictEqual(
      (tokenHandle as unknown as {getId: unknown}).getId,
      undefined,
    );
    // But can be sent back to the remote side
    const result = await ctx.remote.validateToken(tokenHandle);
    assert.strictEqual(result, 'Valid: xyz789');
  });

  void test('handles nested in objects fail in shallow mode', async () => {
    // Handles cannot be nested in objects in shallow mode - they fail structured clone
    const sharedToken = new Token('shared');

    await using ctx = await setupService({
      getSharedHandle(): Handle<Token> {
        return handle(sharedToken);
      },
      checkIdentity(_handles: {a: Handle<Token>; b: Handle<Token>}): boolean {
        return true;
      },
    });

    // Get handles from the server
    const h1 = await ctx.remote.getSharedHandle();
    const h2 = await ctx.remote.getSharedHandle();

    // Trying to send handles nested in an object should fail with DataCloneError
    // because handles are non-cloneable in shallow mode
    try {
      await ctx.remote.checkIdentity({a: h1, b: h2});
      assert.fail('Expected DataCloneError');
    } catch (err) {
      assert.strictEqual((err as Error).name, 'DataCloneError');
    }
  });

  void test('handle round-trip preserves identity', async () => {
    await using ctx = await setupService({
      createToken(): Handle<Token> {
        return handle(new Token('round-trip'));
      },
      returnToken(tokenHandle: Handle<Token>): Handle<Token> {
        // Return the same handle back
        return tokenHandle;
      },
      checkSame(a: Handle<Token>, b: Handle<Token>): boolean {
        const tokenA = getHandleValue(a);
        const tokenB = getHandleValue(b);
        return tokenA === tokenB;
      },
    });

    const token1 = await ctx.remote.createToken();
    const token2 = await ctx.remote.returnToken(token1);

    // Both should be handles to the same token
    const result = await ctx.remote.checkSame(token1, token2);
    assert.strictEqual(result, true);
  });

  void test('getHandleValue retrieves underlying value', () => {
    const token = new Token('test-id');
    const tokenHandle = handle(token);

    const retrieved = getHandleValue(tokenHandle);
    assert.strictEqual(retrieved, token);
    assert.strictEqual(retrieved.getId(), 'test-id');
  });

  void test('handle and proxy to same object are distinct', async () => {
    // A single object can be wrapped as both a handle and a proxy
    // They should not be confused with each other
    const sharedToken = new Token('shared-obj');

    await using ctx = await setupService({
      getAsHandle(): Handle<Token> {
        return handle(sharedToken);
      },
      getAsProxy(): AsyncProxy<Token> {
        return proxy(sharedToken);
      },
      checkHandle(h: Handle<Token>): string {
        const t = getHandleValue(h);
        return `handle:${t.getId()}`;
      },
      checkProxy(p: AsyncProxy<Token>): string {
        const t = getProxyValue(p);
        return `proxy:${t.getId()}`;
      },
      areSameUnderlying(h: Handle<Token>, p: AsyncProxy<Token>): boolean {
        const fromHandle = getHandleValue(h);
        const fromProxy = getProxyValue(p);
        return fromHandle === fromProxy;
      },
    });

    // Get both a handle and a proxy to the same object
    const h = await ctx.remote.getAsHandle();
    const p = await ctx.remote.getAsProxy();

    // Handle is opaque plain object - no property access
    assert.strictEqual((h as unknown as {getId: unknown}).getId, undefined);

    // Debug: Check what p is
    assert.strictEqual(
      typeof p,
      'function',
      `Expected p to be function, got ${typeof p}`,
    );
    assert.strictEqual(
      typeof p.getId,
      'function',
      `Expected p.getId to be function, got ${typeof p.getId}`,
    );

    // Proxy allows method calls
    const idFromProxy = await p.getId();
    assert.strictEqual(idFromProxy, 'shared-obj');

    // Both can be sent back and dereferenced correctly
    const handleResult = await ctx.remote.checkHandle(h);
    assert.strictEqual(handleResult, 'handle:shared-obj');

    const proxyResult = await ctx.remote.checkProxy(p);
    assert.strictEqual(proxyResult, 'proxy:shared-obj');

    // Both refer to the same underlying object
    const sameUnderlying = await ctx.remote.areSameUnderlying(h, p);
    assert.strictEqual(sameUnderlying, true);
  });
});

void suite('handle() - nested mode', () => {
  void test('nested handle in return value', async () => {
    await using ctx = await setupService(
      {
        getTokenData(): {name: string; token: Handle<Token>} {
          return {
            name: 'Result',
            token: handle(new Token('return-token')),
          };
        },
        validateToken(tokenHandle: Handle<Token>): string {
          const token = getHandleValue(tokenHandle);
          return `Valid: ${token.getId()}`;
        },
      },
      {nestedProxies: true},
    );

    const data = await ctx.remote.getTokenData();
    assert.strictEqual(data.name, 'Result');

    // The token handle can be sent back to the server that owns it
    const result = await ctx.remote.validateToken(data.token);
    assert.strictEqual(result, 'Valid: return-token');
  });

  void test('handles from server can be passed in array', async () => {
    await using ctx = await setupService(
      {
        createTokens(): Array<Handle<Token>> {
          return [
            handle(new Token('token1')),
            handle(new Token('token2')),
            handle(new Token('token3')),
          ];
        },
        validateAllTokens(handles: Array<Handle<Token>>): Array<string> {
          return handles.map((h) => getHandleValue(h).getId());
        },
      },
      {nestedProxies: true},
    );

    // Server creates the handles
    const tokens = await ctx.remote.createTokens();

    // Client passes them back
    const result = await ctx.remote.validateAllTokens(tokens);
    assert.deepStrictEqual(result, ['token1', 'token2', 'token3']);
  });

  void test('diamond with handle preserves identity', async () => {
    const sharedToken = new Token('diamond');

    await using ctx = await setupService(
      {
        getSharedHandle(): Handle<Token> {
          return handle(sharedToken);
        },
        checkIdentity(data: {a: Handle<Token>; b: Handle<Token>}): boolean {
          const tokenA = getHandleValue(data.a);
          const tokenB = getHandleValue(data.b);
          return tokenA === tokenB;
        },
      },
      {nestedProxies: true},
    );

    // Get handles from server (same underlying token)
    const h1 = await ctx.remote.getSharedHandle();
    const h2 = await ctx.remote.getSharedHandle();

    const result = await ctx.remote.checkIdentity({a: h1, b: h2});
    assert.strictEqual(result, true);
  });
});
