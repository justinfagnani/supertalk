# supertalk

## 0.0.6

### Patch Changes

- Updated dependencies [79b0d6f]
  - @supertalk/core@0.0.5

## 0.0.5

### Patch Changes

- Updated dependencies [75d8c36]
  - @supertalk/core@0.0.4

## 0.0.4

### Patch Changes

- e9bc8f6: ### Added
  - **`handle()` and `getHandleValue()`** for opaque handle passing — pass
    references across the boundary without exposing an async interface. Handles
    are lightweight marker objects (not JS Proxies) that can be passed back to the
    owning side and dereferenced.
  - **Local proxies work like remote proxies** — `proxy()` now returns an
    `AsyncProxy<T>` that provides the same async interface locally and remotely.
    Methods return promises and properties are accessible via `await`. This means
    the same code works both on the local side or the remote side.
  - **`getProxyValue()`** to extract the underlying value from an `AsyncProxy` on
    the owning side

  ### Changed
  - **Proxies don't auto-unwrap** — When a proxy is sent back across the worker
    boundary, it stays as a proxy rather than being unwrapped to the original
    value. Use `getProxyValue()` on the owning side to access the underlying
    value. This improved the typing of remote APIs and enables APIs that are
    compatible between local and remote sides
  - **Reduced bundle size** from ~2.6 kB to ~2.4 kB brotli through internal
    optimizations

  ### Fixed
  - **Class instances no longer throw in debug mode**: they pass through to
    structured clone (which will clone data but lose methods), matching the
    behavior of shallow mode
  - **Debug mode detects more invalid nested values**: now throws
    `NonCloneableError` for nested `proxy()` and `transfer()` markers in addition
    to functions and promises when `nestedProxies` is not enabled

- Updated dependencies [e9bc8f6]
  - @supertalk/core@0.0.3

## 0.0.3

### Patch Changes

- cb844ea: Add nodeEndpoint() wrapper function for Node Worker support
- Updated dependencies [cb844ea]
  - @supertalk/core@0.0.2

## 0.0.2

### Patch Changes

- 8191ccf: Fix TypeScript build

## 0.0.1

### Patch Changes

- 81a9122: Initial release
- Updated dependencies [81a9122]
  - @supertalk/core@0.0.1
