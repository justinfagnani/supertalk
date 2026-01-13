/**
 * Tests for handle() functionality.
 *
 * This file tests opaque handle passing:
 * - Basic handle creation and passing
 * - Handle caching (same object = same handle)
 * - Handle unwrapping when sent back
 * - Handles work in both shallow and nested modes
 */

import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {setupService} from './test-utils.js';
import {handle} from '../../index.js';
import type {LocalHandle, Remoted} from '../../index.js';

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
  void test('handle can be passed as argument', async () => {
    await using ctx = await setupService({
      validateToken(token: Token): string {
        // token is unwrapped to the original Token instance
        return `Valid: ${token.getId()}`;
      },
    });

    const token = new Token('abc123');
    // Pass the handle directly - it will be unwrapped on the remote side
    const result = await ctx.remote.validateToken(
      handle(token) as unknown as Token,
    );
    assert.strictEqual(result, 'Valid: abc123');
  });

  void test('handle can be returned from method', async () => {
    await using ctx = await setupService({
      createToken(): LocalHandle<Token> {
        return handle(new Token('xyz789'));
      },
      validateToken(token: Token): string {
        return `Valid: ${token.getId()}`;
      },
    });

    // Receive an opaque handle
    const token = await ctx.remote.createToken();
    // Handle is opaque - no properties or methods accessible
    assert.strictEqual(typeof token, 'object');
    // But can be sent back to the remote side
    const result = await ctx.remote.validateToken(token as unknown as Token);
    assert.strictEqual(result, 'Valid: xyz789');
  });

  void test('same object yields same handle', async () => {
    const sharedToken = new Token('shared');

    await using ctx = await setupService({
      checkIdentity(tokens: {a: Token; b: Token}): boolean {
        // Both references should be to the same token
        return tokens.a === tokens.b;
      },
    });

    const wrapped = handle(sharedToken);
    const result = await ctx.remote.checkIdentity({
      a: wrapped as unknown as Token,
      b: wrapped as unknown as Token,
    });
    assert.strictEqual(result, true);
  });

  void test('handle round-trip preserves identity', async () => {
    await using ctx = await setupService({
      createToken(): LocalHandle<Token> {
        return handle(new Token('round-trip'));
      },
      returnToken(token: Token): Token {
        // Return the same token back
        return token;
      },
      checkSame(a: Token, b: Token): boolean {
        return a === b;
      },
    });

    const token1 = await ctx.remote.createToken();
    const token2 = await ctx.remote.returnToken(token1 as unknown as Token);
    
    // Both should be the same handle on the local side
    assert.strictEqual(token1, token2);

    // And the remote side should see them as the same token
    const result = await ctx.remote.checkSame(
      token1 as unknown as Token,
      token2 as unknown as Token,
    );
    assert.strictEqual(result, true);
  });
});

void suite('handle() - nested mode', () => {
  void test('nested handle in object argument', async () => {
    await using ctx = await setupService(
      {
        processData(data: {name: string; token: LocalHandle<Token>}): string {
          const token = data.token as unknown as Token;
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
        validateToken(token: Token): string {
          return `Valid: ${token.getId()}`;
        },
      },
      {nestedProxies: true},
    );

    const data = await ctx.remote.getTokenData();
    assert.strictEqual(data.name, 'Result');
    
    // The token is opaque, but can be sent back
    const result = await ctx.remote.validateToken(data.token as unknown as Token);
    assert.strictEqual(result, 'Valid: return-token');
  });

  void test('handle in array', async () => {
    await using ctx = await setupService(
      {
        validateAllTokens(tokens: Array<Token>): Array<string> {
          return tokens.map((token) => token.getId());
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
      tokens as unknown as Array<Token>,
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
          return data.a === data.b;
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
