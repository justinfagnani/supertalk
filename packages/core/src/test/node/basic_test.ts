import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {VERSION} from '../../index.js';

suite('@supertalk/core', () => {
  test('should export VERSION', () => {
    assert.strictEqual(typeof VERSION, 'string');
    assert.ok(VERSION.length > 0);
  });
});
