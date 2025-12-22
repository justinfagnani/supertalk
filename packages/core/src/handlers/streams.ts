/**
 * @fileoverview Stream handler for ReadableStream and WritableStream.
 *
 * Automatically transfers streams across the wire boundary using the
 * Streams API's built-in transferability.
 */

import {transfer} from '../lib/protocol.js';
import type {Handler, ToWireContext} from '../lib/types.js';

type Stream = ReadableStream | WritableStream;

/**
 * Handler for ReadableStream and WritableStream.
 *
 * Automatically transfers stream instances across the wire boundary.
 * Streams are transferred (moved), not cloned — they cannot be used
 * after transfer.
 *
 * @example
 * ```ts
 * import {wrap} from '@supertalk/core';
 * import {streamHandler} from '@supertalk/core/handlers/streams';
 *
 * const remote = wrap<MyService>(worker, {
 *   handlers: [streamHandler]
 * });
 *
 * // Remote method can return a ReadableStream
 * const stream = await remote.getDataStream();
 * for await (const chunk of stream) {
 *   console.log(chunk);
 * }
 *
 * // Or pass a WritableStream to remote
 * const {writable, readable} = new TransformStream();
 * await remote.writeData(writable);
 * ```
 */
export const streamHandler: Handler<Stream, Stream> = {
  wireType: 'stream',

  canHandle(value: unknown): value is Stream {
    return value instanceof ReadableStream || value instanceof WritableStream;
  },

  toWire(stream: Stream, ctx: ToWireContext): Stream {
    return ctx.toWire(transfer(stream)) as Stream;
  },

  // No fromWire needed — stream transfers intact
};
