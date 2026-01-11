/**
 * Node.js endpoint adapter for supertalk.
 *
 * Adapts Node.js worker_threads Worker and parentPort to the Endpoint interface.
 *
 * @example
 * ```ts
 * // main.ts
 * import {wrap} from '@supertalk/core';
 * import {nodeEndpoint} from '@supertalk/core/node.js';
 * import {Worker} from 'node:worker_threads';
 *
 * const worker = new Worker('./worker.js');
 * const remote = await wrap(nodeEndpoint(worker));
 *
 * // worker.ts
 * import {expose} from '@supertalk/core';
 * import {nodeEndpoint} from '@supertalk/core/node.js';
 * import {parentPort} from 'node:worker_threads';
 *
 * expose(service, nodeEndpoint(parentPort));
 * ```
 */

import type {Endpoint} from './lib/types.js';

/**
 * A Node.js worker_threads endpoint (Worker or parentPort).
 */
export interface NodeEndpoint {
  postMessage(message: unknown, transfer?: ReadonlyArray<unknown>): void;
  on(type: 'message', listener: (data: unknown) => void): void;
  off(type: 'message', listener: (data: unknown) => void): void;
}

/**
 * Adapts a Node.js worker_threads endpoint to the browser-style Endpoint interface.
 *
 * @param nep - A Node.js Worker or parentPort
 * @returns An Endpoint that can be used with wrap() or expose()
 */
export function nodeEndpoint(nep: NodeEndpoint): Endpoint {
  const listeners = new WeakMap<
    (event: MessageEvent) => void,
    (data: unknown) => void
  >();

  return {
    postMessage(message: unknown, transfer?: Array<Transferable>): void {
      nep.postMessage(message, transfer);
    },

    addEventListener(
      _type: 'message',
      listener: (event: MessageEvent) => void,
    ): void {
      const nodeListener = (data: unknown) => {
        listener({data} as MessageEvent);
      };
      nep.on('message', nodeListener);
      listeners.set(listener, nodeListener);
    },

    removeEventListener(
      _type: 'message',
      listener: (event: MessageEvent) => void,
    ): void {
      const nodeListener = listeners.get(listener);
      if (nodeListener) {
        nep.off('message', nodeListener);
        listeners.delete(listener);
      }
    },
  };
}
