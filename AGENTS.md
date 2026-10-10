# AGENTS.md

## Commands

```sh
npm run typecheck          # tsc --noEmit (run FIRST — catches overload/type issues)
npm run build              # tsc --declaration → dist/
npm test                   # node --import ./src/register-hooks.ts --test src/*.test.ts
npm run cli -- [args]      # run CLI from source (no build needed); flags: npm run cli -- --help
```

Run in order typecheck → build → test. Use Node 24+ for source-based development and tests; older-Node smoke tests use compiled `dist/`. Single test file:

```sh
node --import ./src/register-hooks.ts --test src/hooks.test.ts
```

## Project Conventions

- **Zero runtime dependencies**: use Node's standard library; TypeScript and typings remain dev-only.
- Preserve useful comments explaining examples, protocols and format/version constraints. Prefer clear names over redundant commentary.
- Test features and edge cases, not exact error text. Prefer local HTTP servers and isolated cache/tmp fixtures; never clear the user's shared cache.
- Commit only when requested; use a single-line Conventional Commit per logical step.

## TypeScript Constraints

`tsconfig` enforces `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions` — so: no enums/namespaces/parameter properties, `.ts` extensions on relative imports, `import type` for type-only imports.

Additional rules beyond the compiler:

- Prefer overloads/generics over `as` casts. Accepted exception: narrowing untyped boundaries (parseArgs `values`, untyped worker-port messages).
- The implementation signatures of `createResolve`/`createLoad` return `T | Promise<T>` with no explicit return annotation — concrete types reach callers via the overloads. Keep them unannotated.

## Architecture

Loader hook letting scripts `import` and `require` modules directly from HTTP(S) URLs, mirroring Deno.

Load flow:

```text
import "https://…" / require("https://…")
  → hooks.ts resolve() → fetchModuleSync() (fetchModule() for async hooks)
    → cache hit: readCache() → verifyModuleLock()
    → cache miss: worker/network fetch → redirects + source bytes
                  → verifyModuleLock() → writeCache()
  → resolve final HTTP URL (or --tmp file URL)
  → load(): reuse fetched source, or let Node load the temporary file
```

| File | Role |
|---|---|
| `src/hooks.ts` | Shared sync/async resolve+load; final-URL normalization; local-first `npm:` with CDN fallback; bare/JSR mapping; format inference; HTTP/CJS/tmp parents; CLI entry redirect |
| `src/jsr.ts` | `jsr:` specifier validation and mapping to esm.sh's `/jsr/` endpoint (enabled only when the CDN is esm.sh) |
| `src/loader.ts` | Async hooks for `module.register()`; delegates to hooks.ts |
| `src/register-hooks.ts` | Entry point: `registerHooks()` on Node 22.15+, falls back to `register()` on 18.19+/20.6+ |
| `src/sync-fetch.ts` | Verified cache hits or bounded Atomics.wait + persistent worker; resets failed/timed-out workers |
| `src/sync-fetch-worker.ts` | Async `fetchModule()` with cancellation; posts result before notifying the waiting thread |
| `src/fetch.ts` | Up to 10 HTTP redirects; AbortSignal; text/Wasm bytes; lock verification before caching |
| `src/cache.ts` | Deno layout: `$DENO_DIR/remote/<scheme>/<host[_PORTport]>/sha256(pathname + search)`; synchronous atomic writes |
| `src/lock.ts` | Deno v5 hashes and redirect hops; frozen mode; serialized read/modify/write preserving unrelated sections |
| `src/tmp.ts` | Per-process readable session paths; exact reverse URL map including queries/fragments |
| `src/cli.ts` | Consumes leading own options; forwards the remainder unchanged to Node; maps options to env; spawns child `node` |
| `src/progress.ts` | TTY progress bar on stderr during downloads |
| `src/constants.ts` | `NAME`, `DEFAULT_CDN`, `MAX_REDIRECTS=10`, `FETCH_TIMEOUT_MS=60000`, `isHttpUrl()` |
| `src/index.ts` | `fetchModule`, synchronous `clearCache`; types `FetchOptions`, `CacheEntry`, `ModuleSource` |

Byte-format compatibility with Deno's remote cache is intentional — Node and Deno share the cache transparently; keep the metadata comment format stable.

## Gotchas

- **Sync hooks**: no async calls inside resolve/load bodies. All blocking funnels through `fetchModuleSync` (Atomics.wait + worker).
- **Resolve before load**: relative imports and CLI entries must follow redirects before Node chooses a module identity. `pendingLoads` hands source to load without a second download, even with reload.
- **CJS parentURL mangling**: `getHttpParentUrl` reconstructs `file:///cwd/https:/esm.sh/...`. Preserve its regex and the transitive CJS regression tests.
- **npm:**: strip versions only for local `require.resolve`; remote parents use the project directory. Only `MODULE_NOT_FOUND` falls back to the configured CDN or esm.sh, preserving version/subpath; do not mask export errors.
- **Worker startup**: resolve the path from `import.meta.url` for `.ts` and `.js`; use `execArgv: []`. Error/exit callbacks cannot run during Atomics.wait: keep the 60-second bound and reset the worker on timeout. Async fetch accepts `{ signal }`; internal sync fetch accepts `{ timeoutMs }`.
- **cache.ts / lock.ts**: filesystem operations stay synchronous and atomic. Verify source and redirect hops on cache hits too, and before writing downloaded content. Hash mismatches always fail; frozen mode additionally rejects missing records or redirect changes.
- **Lock updates**: reload inside the filesystem lock; preserve npm/JSR/workspace sections. Never reuse a thread-local snapshot for writes.
- **URL identity / tmp**: query participates in the cache key; fragment distinguishes module identities. Temporary files live under `<system-tmp>/node-url-import/session-…/`; reverse-map exact URLs rather than deriving bases from synthetic filenames.
- **CLI entry-point redirect**: registration uses Node's parsed arguments to set `URL_IMPORT_MAIN` for the remote entry. Parentless resolve preserves `import.meta.main`; `process.argv[1]` remains Node's path-normalized entry argument.
- **Remote `createRequire(import.meta.url)`**: native Node rejects HTTP URLs. `--tmp` supplies a file URL; otherwise use a build that avoids this call or a local package.

## Node Version Compatibility

| Feature | Min Node |
|---|---|
| `module.register()` (ESM only) | 18.19 / 20.6 |
| `module.registerHooks()` (ESM + CJS) | 22.15 / 23.5 |
| Remote TypeScript (type stripping) | 22.18 |
| CJS `require()` of HTTP URLs | 24 |

Smoke-test compiled hooks before pushing:

```sh
npm run build
fnm exec --using 18 node --import ./dist/register-hooks.js -e "import('https://esm.sh/ms')"
fnm exec --using 22 node --import ./dist/register-hooks.js -e "import('https://esm.sh/ms')"
fnm exec --using 24 node --import ./dist/register-hooks.js -e "require('https://esm.sh/ms')"
```

## Environment Variables (CLI sets, hooks read)

Set configuration before registering hooks; hook code reads env vars, not CLI flags. Explicit CLI `--frozen=false` / `--no-frozen` and `--cdn=false` / `--no-cdn` override inherited settings:

| Var | Set by | Effect |
|---|---|---|
| `URL_IMPORT_RELOAD=1` | `--reload` | bypass disk cache |
| `URL_IMPORT_TMP=1` | `--tmp` | write modules to readable tmp dir (tmp.ts) |
| `URL_IMPORT_LOCK=path` | `--lock`, `--lock-file <path>`, implied by `--frozen` | enable deno.lock recording/verification |
| `URL_IMPORT_FROZEN=1` | `--frozen` | reject missing hashes and missing/changed redirect records; requires a lock path |
| `URL_IMPORT_CDN=<base/>` | `--cdn[=<url>]` (default `https://esm.sh/`) | map bare packages and missing `npm:` packages; enables `jsr:` when esm.sh |
| `URL_IMPORT_MAIN=<url>` | internal: CLI registration | redirect the Node-selected remote entry to its final URL; CLI clears inherited values |
