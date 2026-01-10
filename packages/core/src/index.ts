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

// Proxy and transfer markers
export {proxy, transfer} from './lib/protocol.js';
export type {TransferMarker} from './lib/protocol.js';

// Utilities
export {NonCloneableError} from './lib/protocol.js';

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
  WireProxy,
  WirePromise,
  Options,
  NestedProxyOptions,
  ShallowOptions,
  Handler,
  ToWireContext,
  FromWireContext,
  HandlerConnectionContext,
} from './lib/types.js';

// Re-export WIRE_TYPE for handlers that need to construct wire values
export {WIRE_TYPE} from './lib/constants.js';
