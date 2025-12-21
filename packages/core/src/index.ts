/**
 * @supertalk/core
 *
 * Type-safe client/server communication for workers, iframes, and RPC.
 *
 * @fileoverview Public API exports.
 */

export const VERSION = '0.0.1';

// Core API
export {expose} from './lib/expose.js';
export {wrap} from './lib/wrap.js';
export {Connection} from './lib/connection.js';

// Proxy marker
export {proxy} from './lib/protocol.js';

// Utilities
export {isPlainObject, NonCloneableError} from './lib/protocol.js';

// Types
export type {
  Endpoint,
  Remote,
  RemoteNested,
  Remoted,
  LocalProxy,
  RemoteProxy,
  Message,
  WireValue,
  Options,
  NestedProxyOptions,
  ShallowOptions,
} from './lib/types.js';
