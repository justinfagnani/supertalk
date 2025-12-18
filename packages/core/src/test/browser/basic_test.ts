import {VERSION} from '../../index.js';

// Using @web/test-runner with mocha's tdd interface (suite/test)
suite('@supertalk/core (browser)', () => {
  test('should export VERSION', () => {
    if (typeof VERSION !== 'string') {
      throw new Error('VERSION should be a string');
    }
    if (VERSION.length === 0) {
      throw new Error('VERSION should not be empty');
    }
  });

  test('should be running in a browser environment', () => {
    if (typeof window === 'undefined') {
      throw new Error('Expected browser environment');
    }
  });
});
