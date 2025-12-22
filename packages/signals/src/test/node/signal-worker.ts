/**
 * Worker script for signal tests.
 *
 * This worker receives service definitions via parentPort and exposes them
 * with signal support. This ensures the sender and receiver have completely
 * isolated signal graphs.
 */

import {parentPort, workerData} from 'node:worker_threads';
import {expose} from '@supertalk/core';
import {Signal} from 'signal-polyfill';
import {SignalManager} from '../../index.js';

if (!parentPort) {
  throw new Error('This file must be run as a worker');
}

// Create signal manager for this worker
const manager = new SignalManager(parentPort);

// Get the service type from workerData
const serviceType = (workerData as {serviceType?: string} | undefined)
  ?.serviceType;

// Create the appropriate service based on type
let service: object;

switch (serviceType) {
  case 'counter': {
    const count = new Signal.State(0);
    service = {
      getCount: () => count,
      increment: () => count.set(count.get() + 1),
      setCount: (n: number) => count.set(n),
    };
    break;
  }

  case 'computed': {
    const count = new Signal.State(0);
    const doubled = new Signal.Computed(() => count.get() * 2);
    service = {
      getCount: () => count,
      getDoubled: () => doubled,
      increment: () => count.set(count.get() + 1),
      setCount: (n: number) => count.set(n),
    };
    break;
  }

  case 'multi': {
    const a = new Signal.State(1);
    const b = new Signal.State(2);
    const sum = new Signal.Computed(() => a.get() + b.get());
    service = {
      getA: () => a,
      getB: () => b,
      getSum: () => sum,
      setA: (n: number) => a.set(n),
      setB: (n: number) => b.set(n),
    };
    break;
  }

  default:
    throw new Error(`Unknown service type: ${String(serviceType)}`);
}

// Expose the service with signal handler
expose(service, parentPort, {
  handlers: [manager.handler],
});
