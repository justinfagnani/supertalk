/**
 * Wire protocol constants.
 *
 * These are runtime values used throughout the library. Separated into their
 * own file to avoid circular dependencies between types.ts and protocol.ts.
 *
 * @fileoverview Constants for the wire protocol.
 */

/**
 * Wire type discriminator property name.
 * This serves as both a brand and type discriminator - user objects won't
 * accidentally have `__supertalk_type__: 'proxy'` etc.
 */
export const WIRE_TYPE = '__supertalk_type__';

/**
 * Symbol used to brand local proxy markers.
 */
export const LOCAL_PROXY = Symbol('supertalk.localProxy');

/**
 * Symbol used to brand local handle markers.
 */
export const LOCAL_HANDLE = Symbol('supertalk.localHandle');

/**
 * Symbol used to brand transfer markers.
 */
export const TRANSFER = Symbol('supertalk.transfer');

/**
 * Reserved message ID for the initialization handshake.
 * The exposed side sends a Return/Throw with this ID to signal readiness.
 */
export const HANDSHAKE_ID = 0;

/**
 * Symbol used to brand proxy properties so they can be detected when passed
 * as arguments. The value contains the target proxy ID and property name.
 */
export const PROXY_PROPERTY_BRAND = Symbol('supertalk.proxyProperty');
