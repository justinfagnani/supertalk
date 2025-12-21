# Agent Instructions for supertalk

## Project Overview

**supertalk** is a type-safe, unified client/server communication library for:

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
3. **Review this file's Memory section** for recorded decisions

### During Implementation

1. **Document first** — Update relevant docs before or alongside code changes
2. **Work incrementally** — Small, testable chunks
3. **Check in frequently** — Pause after significant progress to confirm direction
4. **Write tests** — Prefer test-first for complex logic

### Recording Decisions

When you make or discover important decisions, record them in the Memory section below. Include:

- The decision or discovery
- Brief rationale
- Date

### Memory Format

```markdown
### YYYY-MM-DD: Brief Title

Description of decision/discovery and why it matters.
```

---

## Memory

### 2024-12-17: Initial Project Decisions

**Module format**: ESM-only, no CommonJS support.

**TypeScript**: ESNext target, standard decorators only (no legacy experimentalDecorators).

**Browser support**: Chrome-only initially; can expand later.

**Package structure**:

- `@supertalk/core` — Main implementation
- `supertalk` — Unscoped re-export package for convenience

**Type sharing strategy**: Support multiple patterns:

1. Shared interface package (recommended for larger projects)
2. Type-only import of service class (simpler, works for many cases)
3. Runtime-only (no compile-time types, for dynamic scenarios)

Note: Some features may require runtime metadata from decorators, which would necessitate shared abstract classes rather than pure interfaces.

**Testing**:

- Node: `node:test` runner
- Browser: `@web/test-runner` with Playwright
- Tests run against compiled JS, not TS directly
- Wireit coordinates build → test dependency

**Wireit behavior**: When Wireit skips scripts, it's because:

1. The script already ran and inputs haven't changed (correct caching), OR
2. There's a configuration error and an input file isn't listed in `files`

Never manually clear the Wireit cache. If a script isn't running when expected, check that all input files are listed in the `files` array.

**IMPORTANT**: Wireit handles dependencies automatically. When running tests, do NOT run `build` separately — just run `npm run test:node` and Wireit will build first if needed. The `dependencies` field in wireit config ensures correct ordering.

**CRITICAL - Running Commands**:

- **ALWAYS run from the monorepo root** (`/Users/justin/Projects/Web/supertalk`)
- **NEVER cd into package directories** to run scripts
- Use `npm run <script>` for root scripts: `npm run test`, `npm run test:node`, `npm run lint`
- Use `npm run -w @supertalk/core <script>` to run a script in a specific workspace
- This ensures Wireit properly coordinates dependencies across packages

**Code generation**: Avoid if possible, but remain open if type inference proves insufficient.

### 2024-12-17: Services Are Just Proxied Objects

**Key insight**: A "service" is not a special concept — it's just an object that gets proxied and sent across the communication boundary. The only differences from other proxied objects are:

1. It's usually a singleton
2. It's often the "root" object of a connection (unnamed)

This means `expose(service)` is conceptually `send(proxy(service))`. There's an implicit "root connection handler" that manages handshakes and the initial service exposure.

**Implications**:

- The same proxy mechanism works for services and any other proxied object
- Methods are just non-serializable function properties that get proxied
- Serializable properties get cloned/sent
- No special cases for "top-level" vs nested objects

**Method enumeration**:

- For plain objects: own enumerable properties
- For class instances: walk prototype chain up to (but not including) Object.prototype

### 2024-12-19: No Global Configuration

**Design principle**: Unlike Comlink's global `transferHandlers` map, supertalk has no global state. All configuration is scoped to individual connections via options to `expose()` and `wrap()`.

**Comlink's global state**:

- `Comlink.transferHandlers` — must be configured identically on both sides
- Creates coupling between unrelated connections
- Makes testing harder (global state persists between tests)

**supertalk approach**:

- Configuration via options: `wrap(endpoint, { autoProxy: true })`
- Each connection is isolated
- Easier to test and reason about

### 2024-12-19: Auto-Proxy Mode Design

**Problem**: Automatically traversing payloads to detect functions/proxies has cost and may not always be desired.

**Decision**: Auto-proxy is opt-in (default off). The three modes are:

1. **Manual mode (default)**: Only top-level args and return values are considered for proxying. Nested functions fail to clone (browser's DataCloneError). Simple, predictable, no traversal overhead.

2. **Debug mode (opt-in)**: Traverses payloads to detect non-cloneable values and throws `NonCloneableError` with the exact path. Useful for development when debugging DataCloneError is frustrating.

3. **Auto-proxy mode (opt-in)**: Full payload traversal. Functions and non-plain objects anywhere in the graph are proxied. Diamond patterns result in the same proxy instance.

**Why debug mode**: Comlink users often struggle with `DataCloneError` because the browser doesn't say _where_ in the data the problem is. Debug mode solves this without the full cost of auto-proxying.

**Rationale for abandoning transfer-list pattern**: Considered a postMessage-style transfer list for explicit nested proxies, but replacing proxy markers with actual Proxy objects requires knowing paths, and functions can't be markers. Simpler to just have three clear modes.

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

## Key Files to Know

| File                   | Purpose                                   |
| ---------------------- | ----------------------------------------- |
| `docs/GOALS.md`        | Full requirements and non-goals           |
| `docs/API-DESIGN.md`   | API exploration and decisions             |
| `docs/ARCHITECTURE.md` | Internal system design                    |
| `docs/ROADMAP.md`      | Implementation phases and status          |
| `AGENTS.md`            | This file — agent instructions and memory |

## Questions to Ask Yourself

Before implementing a feature:

1. Is this documented in `docs/`?
2. Does this match the API design in `API-DESIGN.md`?
3. Are there recorded decisions in Memory that affect this?
4. Should I check in with the user before proceeding?

When stuck:

1. Have I read the relevant research (Comlink, tRPC patterns)?
2. Is there a simpler approach that achieves the same goal?
3. Should I ask the user for clarification?
