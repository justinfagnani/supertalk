/**
 * Message protocol utilities.
 *
 * @packageDocumentation
 */

import type {
  CallMessage,
  ReturnMessage,
  ThrowMessage,
  SerializedError,
} from './types.js';

/**
 * Create a call message.
 */
export function createCallMessage(
  id: number,
  method: string,
  args: unknown[],
): CallMessage {
  return {
    type: 'call',
    id,
    method,
    args,
  };
}

/**
 * Create a return message.
 */
export function createReturnMessage(id: number, value: unknown): ReturnMessage {
  return {
    type: 'return',
    id,
    value,
  };
}

/**
 * Create a throw message.
 */
export function createThrowMessage(
  id: number,
  error: SerializedError,
): ThrowMessage {
  return {
    type: 'throw',
    id,
    error,
  };
}

/**
 * Serialize an error for transmission.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
    };
    if (error.stack !== undefined) {
      serialized.stack = error.stack;
    }
    return serialized;
  }
  return {
    name: 'Error',
    message: String(error),
  };
}

/**
 * Deserialize an error from transmission.
 */
export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack) {
    error.stack = serialized.stack;
  }
  return error;
}
