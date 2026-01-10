/**
 * @fileoverview TC39 Signals integration for Supertalk.
 *
 * This package provides reactive state synchronization across communication
 * boundaries (Workers, iframes, etc.) using TC39 Signals.
 *
 * @example
 * ```ts
 * import {expose, wrap} from '@supertalk/core';
 * import {SignalHandler} from '@supertalk/signals';
 * import {Signal} from 'signal-polyfill';
 *
 * // === Worker (sender) ===
 * const count = new Signal.State(0);
 *
 * expose({
 *   get count() { return count; },
 *   increment() { count.set(count.get() + 1); }
 * }, self, { handlers: [new SignalHandler()] });
 *
 * // === Main (receiver) ===
 * const remote = wrap<Service>(worker, { handlers: [new SignalHandler()] });
 *
 * const countSignal = await remote.count;
 * console.log(countSignal.get());  // 0 (initial value, synchronous)
 *
 * effect(() => {
 *   console.log('Count:', countSignal.get());
 * });
 *
 * await remote.increment();  // Effect runs with new value
 * ```
 *
 * @packageDocumentation
 */

export {SignalHandler} from './lib/signal-handler.js';
export type {SignalHandlerOptions} from './lib/signal-handler.js';
export {RemoteSignal} from './lib/remote-signal.js';
export type {
  AnySignal,
  WireSignal,
  SignalBatchUpdate,
  SignalUpdate,
} from './lib/types.js';
