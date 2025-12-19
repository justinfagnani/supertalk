import {VERSION, expose, wrap} from '../../index.js';

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

suite('expose and wrap (browser)', () => {
  test('basic method call via MessageChannel', async () => {
    const {port1, port2} = new MessageChannel();

    const service = {
      add(a: number, b: number): number {
        return a + b;
      },
      greet(name: string): string {
        return `Hello, ${name}!`;
      },
    };

    expose(service, port1);
    const proxy = wrap<typeof service>(port2);

    // In browser, MessagePort needs start() to be called
    port1.start();
    port2.start();

    const sum = await proxy.add(2, 3);
    if (sum !== 5) {
      throw new Error(`Expected 5, got ${String(sum)}`);
    }

    const greeting = await proxy.greet('World');
    if (greeting !== 'Hello, World!') {
      throw new Error(`Expected "Hello, World!", got "${greeting}"`);
    }

    port1.close();
    port2.close();
  });

  test('error propagation', async () => {
    const {port1, port2} = new MessageChannel();

    const service = {
      fail(): never {
        throw new Error('intentional error');
      },
    };

    expose(service, port1);
    const proxy = wrap<typeof service>(port2);

    // In browser, MessagePort needs start() to be called
    port1.start();
    port2.start();

    try {
      await proxy.fail();
      throw new Error('Expected an error to be thrown');
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new Error('Expected an Error instance');
      }
      if (!error.message.includes('intentional error')) {
        throw new Error(`Unexpected error message: ${error.message}`);
      }
    }

    port1.close();
    port2.close();
  });
});
