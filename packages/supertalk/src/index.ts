/**
 * supertalk
 *
 * Type-safe client/server communication for workers, iframes, and RPC.
 *
 * This package re-exports everything from @supertalk/core for convenience.
 */

// Re-export from core using the package name (resolved via package.json exports)
// This works at runtime because @supertalk/core is a dependency
export * from '@supertalk/core';
