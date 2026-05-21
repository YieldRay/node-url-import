# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
# Build (TypeScript → dist/)
npm run build         # tsc --declaration

# Run tests (uses the hook itself to load .ts test files)
npm test              # node --import ./src/register-hooks.ts --test src/*.test.ts
npm run test:register       # test with legacy module.register() path
npm run test:register-hooks # test with module.registerHooks() path (default)

# Type-check without emitting
npm run typecheck     # tsc --noEmit

# Run the CLI directly from source (no build needed)
npm run cli -- [args] # node src/cli.ts
```

Node v22+ required to run tests from source (native TS type-stripping). The compiled `dist/` output supports Node v18.19+ for ESM `import` and Node v24+ for CJS `require`.

## Architecture

The package is a Node.js ESM loader hook that lets scripts `import` modules directly from HTTP(S) URLs, mirroring Deno's behaviour.

**Data flow on first load:**
```
import "https://…"
  → loader.ts resolve()    — calls fetchModule() to follow redirects; returns finalUrl as the
                             canonical URL so relative imports inside the module resolve correctly
  → loader.ts load()       — calls fetchModule() (cache hit), infers format
  → fetch.ts fetchModule() — follows redirects manually (up to MAX_REDIRECTS=10), writes cache + lock
  → cache.ts writeCache()  — writes one Deno-format file per redirect hop + one source entry
  → lock.ts verifyLock()   — checks/updates deno.lock if --lock is active
```

**Data flow for CJS require (Node 24+, via registerHooks):**
```
require("https://…")
  → hooks.ts resolve()       — calls fetchModuleSync(); handles mangled parentURL for transitive imports
  → hooks.ts load()          — calls fetchModuleSync() (cache hit), infers format, returns as ESM
  → sync-fetch.ts            — checks disk cache (readFileSync); on miss:
    → Atomics.wait()         — blocks main thread
    → sync-fetch-worker.ts   — worker runs async fetchModule(), writes cache
    → Atomics.notify()       — wakes main thread
    → receiveMessageOnPort() — reads result from MessagePort
```

**Key modules:**

| File | Role |
|---|---|
| `src/loader.ts` | Async ESM `resolve` + `load` hooks (for `module.register()`); `npm:` specifier stripping; format inference; `--tmp` mode integration |
| `src/hooks.ts` | Synchronous `resolve` + `load` hooks (for `module.registerHooks()`); mirrors `loader.ts` logic but sync; handles CJS parentURL mangling |
| `src/register-hooks.ts` | Primary entry point: uses `module.registerHooks()` on Node 22.15+ (supports import + require), falls back to `module.register()` on older Node |
| `src/register.ts` | Legacy entry point; calls `module.register()` only (ESM import support, no CJS require) |
| `src/sync-fetch.ts` | Synchronous fetch API for hooks: checks disk cache with `readFileSync`, on miss blocks via `Atomics.wait` while worker fetches |
| `src/sync-fetch-worker.ts` | Persistent worker thread that runs async `fetchModule()` and signals completion via `Atomics.notify` + `MessagePort` |
| `src/fetch.ts` | Async HTTP fetch with manual redirect tracking; builds full `redirectChain[]` for cache |
| `src/cache.ts` | Deno-compatible disk cache at `$DENO_DIR/remote/`; files keyed by `sha256(url.pathname)` per host |
| `src/lock.ts` | Deno-compatible lock file (version 5); lazy-loaded, flushed after each write |
| `src/tmp.ts` | `--tmp` mode: writes fetched modules to a human-readable tmp dir mirroring the URL structure; reverse-maps tmp paths back to HTTP URLs for transitive imports |
| `src/cli.ts` | CLI wrapper: parses own flags, forwards unknown flags to Node, spawns child `node` process |
| `src/progress.ts` | TTY progress bar shown on stderr during downloads |
| `src/constants.ts` | `NAME`, `MAX_REDIRECTS`, `isHttpUrl()` |
| `src/index.ts` | Public programmatic API re-exports |

**Four entry points in `package.json` exports:**
- `.` → `dist/index.js` — programmatic API (`fetchModule`, `clearCache`, etc.)
- `./loader` → `dist/loader.js` — legacy `--loader` flag
- `./register` → `dist/register-hooks.js` — modern `--import` flag (uses `registerHooks` on Node 22.15+, falls back to `register`)
- `./register-legacy` → `dist/register.js` — legacy `module.register()` only path

**Cache format:** Identical to Deno's remote module cache. Directory: `$DENO_DIR/remote/<scheme>/<host>/` (respects `DENO_DIR` env var; defaults to `~/Library/Caches/deno/remote` on macOS, `~/.cache/deno/remote` on Linux). Filename: `sha256(url.pathname)` (hex). Redirect stubs: whole file is `\n// denoCacheMetadata=<JSON>`. Source entries: `<raw source>\n// denoCacheMetadata=<JSON>` appended at end. Node and Deno share the same cache transparently.

**TypeScript setup:** Uses Node's native type-stripping (no ts-node). Source files use `.ts` extensions in imports. `erasableSyntaxOnly: true` means no enums or namespaces. Build emits `.js` + `.d.ts` to `dist/`.

**CLI flag forwarding:** The CLI spawns a child `node` process rather than running inline. Own flags (`--reload`, `--lock`, etc.) are translated to environment variables (`URL_IMPORT_RELOAD`, `URL_IMPORT_LOCK`, etc.) so the loader thread picks them up.
