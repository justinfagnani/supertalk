/**
 * @supertalk/core
 *
 * Type-safe client/server communication for workers, iframes, and RPC.
 *
 * @packageDocumentation
 */

export const VERSION = '0.0.1';

// Core API
export {expose} from './lib/expose.js';
export {wrap} from './lib/wrap.js';
export {Connection} from './lib/connection.js';

// Utilities
export {isPlainObject, NonCloneableError} from './lib/protocol.js';

// Types
export type {
  Endpoint,
  Remote,
  RemoteAutoProxy,
  Remoted,
  Proxied,
  Message,
  WireValue,
  Options,
  AutoProxyOptions,
  ManualOptions,
} from './lib/types.js';
export {ROOT_TARGET} from './lib/types.js';
