# Agent Instructions for Supertalk

## Project Overview

**Supertalk** is a type-safe, unified client/server communication library for:

- Web Workers
- Iframes
- Node.js worker threads
- Browser-to-server RPC (HTTP/WebSocket)

It aims to replace [Comlink](https://github.com/GoogleChromeLabs/comlink/) (which lacks composability and rich typing) and potentially [tRPC](https://trpc.io/) (which has verbose builder APIs and requires type imports from server).

## Core Goals

1. **Type-safe** — Clients get typed interfaces; servers get guidance on producing serializable types
2. **Simple DX** — Basic request/response should be trivial
3. **Decoupled types** — Define service interface separately from implementation; no mandatory server imports
4. **Declarative** — Prefer decorated classes over builder patterns
5. **Rich serialization** — Structured clone + transferables for postMessage; JSON + pluggable serializers (superjson) for HTTP
6. **Async-first** — Support promises, streams, async iterables as first-class citizens
7. **Proxy support** — Easy proxying for functions, expensive objects, graph nodes
8. **Signals integration** — TC39 Signals for reactive state sync across boundaries
9. **Memory safe** — WeakRef/FinalizationRegistry for automatic proxy cleanup
10. **Composable** — Nested objects, sub-services, no special cases for top-level vs nested

## Coding Standards

### Language & Runtime

- **ESM-only** — No CommonJS
- **ESNext target** — Use latest JS features
- **Chrome-only initially** — Can use bleeding-edge APIs
- **Node 20+** — Minimum supported version

### TypeScript

- **Standard decorators** (Stage 3) — No `experimentalDecorators`
- **Strict mode** — All strict flags enabled
- **`verbatimModuleSyntax`** — Explicit `type` imports
- **Private fields** — Use `#field` syntax, not `private`

### Modern APIs to Use

- `WeakRef` and `FinalizationRegistry` for memory management
- `using` declarations for resource management where appropriate
- Private class fields (`#field`)
- Standard decorators
- `AbortSignal` for cancellation
- `ReadableStream` / `WritableStream` for streaming

### Testing

- **Node tests**: `node:test` with `node --test`
- **Browser tests**: `@web/test-runner` with Playwright
- **Tests run against compiled JS** — Wireit ensures build before test
- **Test API**: Use `suite()` and `test()`, not `describe()` and `it()`
- Test files: `test/node/*_test.js`, `test/browser/*_test.js`

### Bundle Size

Keep the library small! Run the size check during development:

```bash
WIREIT_LOGGER=simple npm run checksize
```

This uses Rollup + Terser + `rollup-plugin-summary` to show:

- **Size**: Unminified bundle
- **Minified**: After Terser (private fields are auto-mangled)
- **Gzipped**: Compressed size
- **Brotli**: Best-case compressed size

Current target: **~2 kB** brotli-compressed.

### Source & Build Structure

- **All source under `src/`** — Including tests: `src/test/node/`, `src/test/browser/`
- **Build output to root** — `src/index.ts` → `index.js`, `src/lib/` → `lib/`, `src/test/` → `test/`
- **Test file naming** — End with `_test.ts` (not `.test.ts`) to distinguish from test utilities
- **Gitignored outputs** — `index.*`, `lib/`, `test/` at package root are gitignored

### Code Style

- Prettier with project config
- ESLint with strict TypeScript rules
- Consistent type imports: `import type { Foo } from './foo.js'`
- **Prefer type inference** — Don't annotate field or variable types when they can be inferred. Use generics at the constructor/function call instead:

  ```typescript
  // ✅ Good: type inferred from constructor
  #docs = new Map<string, unknown>();

  // ❌ Avoid: redundant type annotation
  #docs: Map<string, unknown> = new Map();
  ```

## Workflow Instructions

### Before Starting Any Task

1. **Ask clarifying questions** if requirements are ambiguous
2. **Check existing documentation** in `docs/` for context
3. **Review this file** for design decisions and tips

### During Implementation

1. **Document first** — Update relevant docs before or alongside code changes
2. **Work incrementally** — Small, testable chunks
3. **Check in frequently** — Pause after significant progress to confirm direction
4. **Write tests** — Prefer test-first for complex logic

### Maintaining This File

Keep AGENTS.md as a **living document** — a current snapshot of key instructions, not a changelog.

When you discover something worth recording (coding patterns, implementation details, debugging tips):

- Add it to the appropriate section
- Organize as if writing documentation, not a log entry
- No dates or "discovered on..." framing
- Consolidate related information; avoid duplication

---

## Key Design Decisions

### Pre-Release: No Backwards Compatibility

This library is not yet released. We prioritize clean APIs and minimal code size over backwards compatibility. Feel free to:

- Remove deprecated methods
- Rename or refactor freely
- Consolidate redundant APIs
- Break changes without migration paths

### No Global Configuration

Unlike Comlink's global `transferHandlers` map, Supertalk has no global state. All configuration is scoped to individual connections via options to `expose()` and `wrap()`.

### Explicit `proxy()` for Type-Safe Proxying

**What gets auto-proxied (always):**

- Functions (unambiguously non-cloneable)
- Promises (also non-cloneable)
- The root service via `expose()`

**When to use explicit `proxy()`:**

- Class instances where you need methods (prototypes are skipped during cloning)
- Mutable objects where the remote side should see updates
- Large objects to avoid cloning overhead

**When to use `handle()`:**

- Opaque tokens or session identifiers
- References where you don't want to expose the object's interface
- Graph nodes that should only be accessed on the owning side

**Types are consistent on both sides:**

```ts
interface MyService {
  createWidget(): AsyncProxy<Widget>; // Same type on both sides
  createSession(): Handle<Session>; // Same type on both sides
  getData(): {value: number}; // Cloned, same shape
}
```

Use `getProxyValue()` and `getHandleValue()` on the owning side to extract the
underlying value. These throw on the remote side.

### No Auto-Unwrapping

Proxies and handles stay as proxies/handles when sent back across the boundary.
This enables consistent bidirectional APIs:

```ts
// Service accepts the same types it returns
interface MyService {
  createWidget(): AsyncProxy<Widget>;
  updateWidget(widget: AsyncProxy<Widget>): void;
}
```

### Proxy Modes

1. **Shallow mode (default, `nestedProxies: false`)**: Only top-level function arguments are proxied. No traversal. Maximum performance. Nested functions/promises fail with DataCloneError.

2. **Debug mode (`debug: true`)**: Traverses payloads to detect non-cloneable values and throws `NonCloneableError` with the exact path. Detects nested functions, promises, `proxy()` markers, and `transfer()` markers that would fail without `nestedProxies: true`.

3. **Nested mode (`nestedProxies: true`)**: Full payload traversal. Functions and promises are auto-proxied anywhere. Class instances require explicit `proxy()` markers.

### Services Are Just Proxied Objects

A "service" is not a special concept — it's just an object that gets proxied. The same proxy mechanism works for services and any other proxied object:

- Methods are non-serializable function properties that get proxied
- Serializable properties get cloned/sent
- No special cases for "top-level" vs nested objects

**Method enumeration:**

- For plain objects: own enumerable properties
- For class instances: walk prototype chain up to (but not including) Object.prototype

---

## Wireit & Commands

**CRITICAL**: Always run commands from the monorepo root (`/Users/justin/Projects/Web/supertalk`), never cd into package directories.

```bash
npm run test          # All tests
npm run test:node     # Node tests only
npm run lint          # Lint
npm run -w @supertalk/core <script>  # Run in specific workspace
```

Wireit handles dependencies automatically — don't run `build` separately before tests.

**Debugging tip**: If a script isn't running when expected, check that all input files are listed in the `files` array in the wireit config. Never manually clear the Wireit cache.

---

## Package Structure

```
supertalk/
├── packages/
│   ├── core/           # @supertalk/core - main implementation
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── lib/        # Library source
│   │   │   └── test/       # Test source
│   │   │       ├── node/
│   │   │       └── browser/
│   │   ├── index.js        # Built (gitignored)
│   │   ├── lib/            # Built (gitignored)
│   │   ├── test/           # Built (gitignored)
│   │   └── package.json
│   └── supertalk/      # supertalk - re-exports @supertalk/core
├── docs/
│   ├── GOALS.md        # Detailed requirements
│   ├── ARCHITECTURE.md # System design
│   ├── API-DESIGN.md   # DX exploration
│   └── ROADMAP.md      # Implementation phases
├── AGENTS.md           # This file
└── package.json        # Workspace root
```

## Key Files

| File                   | Purpose                          |
| ---------------------- | -------------------------------- |
| `docs/GOALS.md`        | Full requirements and non-goals  |
| `docs/API-DESIGN.md`   | API exploration and decisions    |
| `docs/ARCHITECTURE.md` | Internal system design           |
| `docs/ROADMAP.md`      | Implementation phases and status |
