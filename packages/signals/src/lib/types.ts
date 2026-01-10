/**
 * @fileoverview Type definitions for @supertalk/signals.
 *
 * This file defines the types used by the signals handler.
 */

import {WIRE_TYPE} from '@supertalk/core';
import type {Signal} from 'signal-polyfill';

/**
 * Wire type identifier for signals.
 */
export const SIGNAL_WIRE_TYPE = 'signal';

/**
 * A signal type - either State or Computed.
 */
export type AnySignal<T = unknown> = Signal.State<T> | Signal.Computed<T>;

/**
 * Wire format for a signal.
 */
export interface WireSignal<T = unknown> {
  readonly [WIRE_TYPE]: typeof SIGNAL_WIRE_TYPE;
  readonly signalId: number;
  readonly value: T;
}

/**
 * Batch update message sent from sender to receiver.
 */
export interface SignalBatchUpdate {
  readonly type: 'signal:batch';
  readonly updates: ReadonlyArray<SignalUpdate>;
}

/**
 * A single signal update within a batch.
 */
export interface SignalUpdate {
  readonly signalId: number;
  readonly value: unknown;
}

/**
 * Check if a value is a WireSignal.
 */
export function isWireSignal(value: unknown): value is WireSignal {
  if (value === null || typeof value !== 'object' || !(WIRE_TYPE in value)) {
    return false;
  }
  const wireType = (value as Record<string, unknown>)[WIRE_TYPE];
  return wireType === SIGNAL_WIRE_TYPE;
}

/**
 * Check if a message is a SignalBatchUpdate.
 */
export function isSignalBatchUpdate(
  message: unknown,
): message is SignalBatchUpdate {
  if (message === null || typeof message !== 'object' || !('type' in message)) {
    return false;
  }
  const type = (message as Record<string, unknown>)['type'];
  return type === 'signal:batch';
}

/**
 * Release message sent from receiver to sender when a RemoteSignal is GC'd.
 */
export interface SignalReleaseMessage {
  readonly type: 'signal:release';
  readonly signalId: number;
}

/**
 * Check if a message is a SignalReleaseMessage.
 */
export function isSignalReleaseMessage(
  message: unknown,
): message is SignalReleaseMessage {
  if (message === null || typeof message !== 'object' || !('type' in message)) {
    return false;
  }
  const type = (message as Record<string, unknown>)['type'];
  return type === 'signal:release';
}
