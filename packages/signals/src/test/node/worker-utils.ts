/**
 * Test utilities for @supertalk/signals using real workers.
 *
 * Using real workers ensures the sender and receiver have completely
 * isolated signal graphs, which is critical for accurate testing.
 */

import {
  Worker,
  type Transferable as NodeTransferable,
} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {wrap} from '@supertalk/core';
import type {Endpoint} from '@supertalk/core';
import {SignalHandler} from '../../index.js';
import type {SignalHandlerOptions, RemoteSignal} from '../../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'signal-worker.js');

/**
 * Service types available in the worker.
 */
export type ServiceType = 'counter' | 'computed' | 'multi';

/**
 * Adapt a Node Worker to the Endpoint interface.
 */
function workerToEndpoint(worker: Worker): Endpoint {
  return {
    postMessage: (message, transfer) =>
      worker.postMessage(
        message,
        transfer as Array<NodeTransferable> | undefined,
      ),
    addEventListener: (_type, listener) => {
      // We only support 'message' events
      worker.on('message', (data: unknown) => {
        listener({data} as MessageEvent);
      });
    },
    removeEventListener: (_type, _listener) => {
      // Node workers use .off() but we'd need to track the wrapped listener
      // For tests, we just terminate the worker to clean up
    },
  };
}

/**
 * Service interfaces for each service type (after signal transfer).
 * Signals become RemoteSignals on the receiving side.
 * Methods return Promises because they go through the RPC layer.
 */
export interface CounterService {
  getCount(): Promise<RemoteSignal<number>>;
  increment(): Promise<void>;
  setCount(n: number): Promise<void>;
}

export interface ComputedService {
  getCount(): Promise<RemoteSignal<number>>;
  getDoubled(): Promise<RemoteSignal<number>>;
  increment(): Promise<void>;
  setCount(n: number): Promise<void>;
}

export interface MultiService {
  getA(): Promise<RemoteSignal<number>>;
  getB(): Promise<RemoteSignal<number>>;
  getSum(): Promise<RemoteSignal<number>>;
  setA(n: number): Promise<void>;
  setB(n: number): Promise<void>;
}

/**
 * A disposable test context with a real worker.
 */
export interface WorkerContext<T> {
  /** The wrapped remote proxy */
  remote: T;
  /** Signal handler for the main thread (receiver) side */
  signalHandler: SignalHandler;
  /** The worker instance */
  worker: Worker;
  /** Dispose method for `using` declarations */
  [Symbol.dispose]: () => void;
}

/**
 * Options for createWorker.
 */
export interface CreateWorkerOptions {
  /** Options to pass to SignalHandler on both sides */
  signalHandlerOptions?: SignalHandlerOptions;
}

/**
 * Create a worker with the specified service type.
 */
export function createWorker(
  serviceType: 'counter',
  options?: CreateWorkerOptions,
): Promise<WorkerContext<CounterService>>;
export function createWorker(
  serviceType: 'computed',
  options?: CreateWorkerOptions,
): Promise<WorkerContext<ComputedService>>;
export function createWorker(
  serviceType: 'multi',
  options?: CreateWorkerOptions,
): Promise<WorkerContext<MultiService>>;
export async function createWorker(
  serviceType: ServiceType,
  options: CreateWorkerOptions = {},
): Promise<WorkerContext<unknown>> {
  const worker = new Worker(WORKER_PATH, {
    workerData: {
      serviceType,
      signalHandlerOptions: options.signalHandlerOptions,
    },
  });

  const endpoint = workerToEndpoint(worker);
  const signalHandler = new SignalHandler(options.signalHandlerOptions);
  const remote = await wrap(endpoint, {
    handlers: [signalHandler],
  });

  return {
    remote,
    signalHandler,
    worker,
    [Symbol.dispose]() {
      void worker.terminate();
    },
  };
}

/**
 * Wait for the next microtask to flush.
 */
export function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

/**
 * Wait for N microtasks (useful for letting batched updates propagate).
 */
export async function waitMicrotasks(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) {
    await nextMicrotask();
  }
}

/**
 * Wait for a short delay to allow cross-worker messages to propagate.
 * This is more reliable than microtasks for worker communication.
 */
export function waitForWorker(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
