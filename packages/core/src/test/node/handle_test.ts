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
import {handle, getHandleValue} from '../../index.js';
import type {LocalHandle} from '../../index.js';

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
  void test('handle can be passed and dereferenced', async () => {
    await using ctx = await setupService({
      validateToken(tokenHandle: LocalHandle<Token>): string {
        // Explicitly dereference the handle
        const token = getHandleValue(tokenHandle);
        return `Valid: ${token.getId()}`;
      },
    });

    const token = new Token('abc123');
    const tokenHandle = handle(token);
    const result = await ctx.remote.validateToken(
      tokenHandle as unknown as LocalHandle<Token>,
    );
    assert.strictEqual(result, 'Valid: abc123');
  });

  void test('handle can be returned from method', async () => {
    await using ctx = await setupService({
      createToken(): LocalHandle<Token> {
        return handle(new Token('xyz789'));
      },
      validateToken(tokenHandle: LocalHandle<Token>): string {
        const token = getHandleValue(tokenHandle);
        return `Valid: ${token.getId()}`;
      },
    });

    // Receive an opaque handle
    const tokenHandle = await ctx.remote.createToken();
    // Handle is opaque - no properties or methods accessible
    assert.strictEqual(typeof tokenHandle, 'object');
    // But can be sent back to the remote side
    const result = await ctx.remote.validateToken(
      tokenHandle as unknown as LocalHandle<Token>,
    );
    assert.strictEqual(result, 'Valid: xyz789');
  });

  void test('same object yields same handle', async () => {
    const sharedToken = new Token('shared');

    await using ctx = await setupService({
      checkIdentity(handles: {
        a: LocalHandle<Token>;
        b: LocalHandle<Token>;
      }): boolean {
        // Both handles should refer to the same token
        const tokenA = getHandleValue(handles.a);
        const tokenB = getHandleValue(handles.b);
        return tokenA === tokenB;
      },
    });

    const wrapped = handle(sharedToken);
    const result = await ctx.remote.checkIdentity({
      a: wrapped as unknown as LocalHandle<Token>,
      b: wrapped as unknown as LocalHandle<Token>,
    });
    assert.strictEqual(result, true);
  });

  void test('handle round-trip preserves identity', async () => {
    await using ctx = await setupService({
      createToken(): LocalHandle<Token> {
        return handle(new Token('round-trip'));
      },
      returnToken(tokenHandle: LocalHandle<Token>): LocalHandle<Token> {
        // Return the same handle back
        return tokenHandle;
      },
      checkSame(
        a: LocalHandle<Token>,
        b: LocalHandle<Token>,
      ): boolean {
        const tokenA = getHandleValue(a);
        const tokenB = getHandleValue(b);
        return tokenA === tokenB;
      },
    });

    const token1 = await ctx.remote.createToken();
    const token2 = await ctx.remote.returnToken(
      token1 as unknown as LocalHandle<Token>,
    );

    // Both should be handles to the same token
    const result = await ctx.remote.checkSame(
      token1 as unknown as LocalHandle<Token>,
      token2 as unknown as LocalHandle<Token>,
    );
    assert.strictEqual(result, true);
  });

  void test('getHandleValue retrieves underlying value', async () => {
    const token = new Token('test-id');
    const tokenHandle = handle(token);

    const retrieved = getHandleValue(tokenHandle);
    assert.strictEqual(retrieved, token);
    assert.strictEqual(retrieved.getId(), 'test-id');
  });
});

void suite('handle() - nested mode', () => {
  void test('nested handle in object argument', async () => {
    await using ctx = await setupService(
      {
        processData(data: {name: string; token: LocalHandle<Token>}): string {
          const token = getHandleValue(data.token);
          return `${data.name}: ${token.getId()}`;
        },
      },
      {nestedProxies: true},
    );

    const token = new Token('nested-token');
    const result = await ctx.remote.processData({
      name: 'Test',
      token: handle(token),
    });
    assert.strictEqual(result, 'Test: nested-token');
  });

  void test('nested handle in return value', async () => {
    await using ctx = await setupService(
      {
        getTokenData(): {name: string; token: LocalHandle<Token>} {
          return {
            name: 'Result',
            token: handle(new Token('return-token')),
          };
        },
        validateToken(tokenHandle: LocalHandle<Token>): string {
          const token = getHandleValue(tokenHandle);
          return `Valid: ${token.getId()}`;
        },
      },
      {nestedProxies: true},
    );

    const data = await ctx.remote.getTokenData();
    assert.strictEqual(data.name, 'Result');

    // The token handle can be sent back
    const result = await ctx.remote.validateToken(
      data.token as unknown as LocalHandle<Token>,
    );
    assert.strictEqual(result, 'Valid: return-token');
  });

  void test('handle in array', async () => {
    await using ctx = await setupService(
      {
        validateAllTokens(handles: Array<LocalHandle<Token>>): Array<string> {
          return handles.map((h) => getHandleValue(h).getId());
        },
      },
      {nestedProxies: true},
    );

    const tokens = [
      handle(new Token('token1')),
      handle(new Token('token2')),
      handle(new Token('token3')),
    ];

    const result = await ctx.remote.validateAllTokens(
      tokens as unknown as Array<LocalHandle<Token>>,
    );
    assert.deepStrictEqual(result, ['token1', 'token2', 'token3']);
  });

  void test('diamond with handle preserves identity', async () => {
    await using ctx = await setupService(
      {
        checkIdentity(data: {
          a: LocalHandle<Token>;
          b: LocalHandle<Token>;
        }): boolean {
          const tokenA = getHandleValue(data.a);
          const tokenB = getHandleValue(data.b);
          return tokenA === tokenB;
        },
      },
      {nestedProxies: true},
    );

    const sharedToken = new Token('diamond');
    const wrapped = handle(sharedToken);
    const result = await ctx.remote.checkIdentity({
      a: wrapped,
      b: wrapped,
    });
    assert.strictEqual(result, true);
  });
});
