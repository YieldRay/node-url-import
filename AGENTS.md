# AGENTS.md

## Commands

```sh
npm run typecheck          # tsc --noEmit (run FIRST — catches overload/type issues)
npm run build              # tsc --declaration → dist/
npm test                   # node --import ./src/register-hooks.ts --test src/*.test.ts
npm run cli -- [args]      # run CLI from source (no build needed)
```

**Order matters:** `typecheck → build → test`. Tests load from `src/` via the hook (no build needed), but `build` must pass before publishing.

**Run a single test file:**
```sh
node --import ./src/register-hooks.ts --test src/hooks.test.ts
```

## TypeScript Constraints

- `erasableSyntaxOnly: true` — no `enum`, no `namespace`, no parameter properties
- `verbatimModuleSyntax: true` — use `import type { … }` for type-only imports; no `import { type Foo }`-style mixed with value imports unless separate statement
- `.ts` extensions in all relative imports (Node native type-stripping)
- `rewriteRelativeImportExtensions: true` — tsc rewrites `.ts` → `.js` in emit
- No `as` type casts in production code — use overloads or generics instead

## Architecture

Node.js loader hook that lets scripts `import` and `require` modules directly from HTTP(S) URLs, mirroring Deno's behaviour.

**Data flow on first load (import or require):**
```
import "https://…" / require("https://…")
  → hooks.ts resolve()       — calls fetchModuleSync(); handles mangled parentURL for transitive imports
  → hooks.ts load()          — calls fetchModuleSync() (cache hit), infers format, returns as ESM
  → sync-fetch.ts            — checks disk cache (readFileSync); on miss:
    → Atomics.wait()         — blocks main thread
    → sync-fetch-worker.ts   — worker runs async fetchModule(), writes cache
    → Atomics.notify()       — wakes main thread
    → receiveMessageOnPort() — reads result from MessagePort
  → fetch.ts fetchModule()   — follows redirects manually (up to MAX_REDIRECTS=10), writes cache + lock
  → cache.ts writeCache()    — writes one Deno-format file per redirect hop + one source entry
  → lock.ts verifyLock()     — checks/updates deno.lock if --lock is active
```

**Key modules:**

| File | Role |
|---|---|
| `src/hooks.ts` | Synchronous `resolve` + `load` hooks (for `module.registerHooks()`); `npm:` specifier stripping; format inference; handles CJS parentURL mangling for transitive imports |
| `src/loader.ts` | Async `resolve` + `load` hooks (for `module.register()`); thin wrapper delegating to hooks.ts |
| `src/register-hooks.ts` | Entry point: calls `module.registerHooks()` on Node 22.15+, falls back to `module.register()` on 18.19+/20.6+ |
| `src/sync-fetch.ts` | Checks disk cache with `readFileSync`, on miss blocks via `Atomics.wait` while worker fetches |
| `src/sync-fetch-worker.ts` | Persistent worker thread running async `fetchModule()`, signals via `Atomics.notify` + `MessagePort` |
| `src/fetch.ts` | Async HTTP fetch with manual redirect tracking; builds full `redirectChain[]` for cache |
| `src/cache.ts` | Deno-compatible disk cache at `$DENO_DIR/remote/`; files keyed by `sha256(url.pathname)` per host |
| `src/lock.ts` | Deno-compatible lock file (version 5); lazy-loaded, flushed after each write |
| `src/tmp.ts` | `--tmp` mode: writes fetched modules to human-readable tmp dir; reverse-maps tmp paths back to HTTP URLs |
| `src/cli.ts` | CLI wrapper: parses own flags, forwards unknown flags to Node, spawns child `node` process |
| `src/progress.ts` | TTY progress bar shown on stderr during downloads |
| `src/constants.ts` | `NAME`, `MAX_REDIRECTS`, `isHttpUrl()` |
| `src/index.ts` | Public programmatic API re-exports |

**Package exports:**
- `.` → `dist/index.js` — programmatic API (`fetchModule`, `clearCache`, etc.)
- `./register` → `dist/register-hooks.js` — `--import` flag entry point

**Cache format:** Identical to Deno's remote module cache. Directory: `$DENO_DIR/remote/<scheme>/<host>/` (respects `DENO_DIR` env var; defaults to `~/Library/Caches/deno/remote` on macOS, `~/.cache/deno/remote` on Linux). Filename: `sha256(url.pathname)` (hex). Node and Deno share the same cache transparently.

## Critical Patterns

### Sync hooks (hooks.ts)
- `createResolve(fetchFn)` / `createLoad(fetchFn)` are overloaded: sync fetchFn → `ResolveHookSync`, async fetchFn → `ResolveHookAsync`
- Implementation signature returns `T | Promise<T>` but callers see concrete overload types — never add explicit return type annotation to the implementation
- `fetchModuleSync` blocks via `Atomics.wait` + worker; never call async functions in the resolve/load body

### CJS parentURL mangling
- When Node requires a CJS file that imports an HTTP URL, the parentURL is mangled to a file path like `file:///cwd/https:/esm.sh/...`
- `extractHttpUrlFromParent` reconstructs the real HTTP URL — any change to this regex breaks transitive CJS imports

### Worker path resolution (sync-fetch.ts)
- Worker file path must resolve from both `.ts` (dev, Node 24+ type-stripping) and compiled `.js` (dist)
- Uses `import.meta.url` + relative path; do NOT hardcode absolute paths

### Cache (cache.ts) and Lock (lock.ts)
- All filesystem operations are synchronous (`readFileSync`, `writeFileSync`, `mkdirSync`)
- Cache format is Deno-compatible; don't change the metadata comment format

### CLI flag forwarding
- The CLI spawns a child `node` process rather than running inline
- Own flags (`--reload`, `--lock`, etc.) are translated to environment variables so the loader thread picks them up

## Node Version Compatibility

| Feature | Minimum Node |
|---------|-------------|
| `module.register()` (ESM only) | 18.19 / 20.6 |
| `module.registerHooks()` (ESM + CJS) | 22.15 / 23.5 |
| CJS `require()` of HTTP URLs | 24+ |
| Native `.ts` type-stripping (dev) | 22.6+ (with `--experimental-strip-types`) / 24+ (stable) |

## Smoke Testing Across Versions

Use `fnm` (or `nvm`) to verify before pushing:
```sh
fnm use 18 && node --import ./src/register-hooks.ts -e "import('https://esm.sh/ms')"
fnm use 22 && node --import ./src/register-hooks.ts -e "import('https://esm.sh/ms')"
fnm use 24 && node --import ./src/register-hooks.ts -e "require('https://esm.sh/ms')"
```

## Environment Variables (set by CLI, read by hooks)

`URL_IMPORT_RELOAD`, `URL_IMPORT_LOCK`, `URL_IMPORT_TMP` — the CLI translates its own flags into these so the loader thread picks them up. Don't read CLI flags directly in hook code.
