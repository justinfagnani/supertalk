/**
 * Worker fixture for nodeEndpoint tests.
 */

import {parentPort} from 'node:worker_threads';
import {expose} from '../../index.js';

const service = {
  add(a: number, b: number): number {
    return a + b;
  },
  greet(name: string): string {
    return `Hello, ${name}!`;
  },
};

if (parentPort) {
  expose(service, parentPort);
}
