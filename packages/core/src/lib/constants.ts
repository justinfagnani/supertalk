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
 * accidentally have `__st__: 'proxy'` etc.
 */
export const WIRE_TYPE = '__st__';

/**
 * Symbol used to store the underlying value in proxy/handle markers.
 * On the owning side, this contains the actual value.
 * On the remote side, this is undefined (the value lives on the other end).
 */
export const PROXY_VALUE = Symbol();

/**
 * Symbol used to brand transfer markers.
 */
export const TRANSFER = Symbol();

/**
 * A function used to make objects non-cloneable via structured clone.
 * Objects with this symbol as a property will fail to clone.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function
export const NON_CLONEABLE: () => void = () => {};

/**
 * Reserved message ID for the initialization handshake.
 * The exposed side sends a Return/Throw with this ID to signal readiness.
 */
export const HANDSHAKE_ID = 0;

/**
 * Symbol used to brand proxy properties so they can be detected when passed
 * as arguments. The value contains the target proxy ID and property name.
 */
export const PROXY_PROPERTY_BRAND = Symbol();
