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

// Types
export type {Endpoint, Remote, Message} from './lib/types.js';
