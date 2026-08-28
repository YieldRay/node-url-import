# AGENTS.md

## Commands

```sh
npm run typecheck          # tsc --noEmit (run FIRST — catches overload/type issues)
npm run build              # tsc --declaration → dist/
npm test                   # node --import ./src/register-hooks.ts --test src/*.test.ts
npm run cli -- [args]      # run CLI from source (no build needed); flags: npm run cli -- --help
```

Run in order typecheck → build → test. Tests run from `src/` via the hook (build needed only before publishing). Single test file:

```sh
node --import ./src/register-hooks.ts --test src/hooks.test.ts
```

## TypeScript Constraints

`tsconfig` enforces `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions` — so: no enums/namespaces/parameter properties, `.ts` extensions on relative imports, `import type` for type-only imports.

Additional rules beyond the compiler:

- Prefer overloads/generics over `as` casts. Accepted exception: narrowing untyped boundaries (parseArgs `values`, untyped worker-port messages).
- The implementation signatures of `createResolve`/`createLoad` return `T | Promise<T>` with no explicit return annotation — concrete types reach callers via the overloads. Keep them unannotated.

## Architecture

Loader hook letting scripts `import` and `require` modules directly from HTTP(S) URLs, mirroring Deno.

Data flow on first load:

```
import "https://…" / require("https://…")
  → hooks.ts resolve()/load()  — fetchModuleSync(); parentURL, npm:, cdn handling
  → sync-fetch.ts              — disk-cache hit → readFileSync; miss:
                                 Atomics.wait() blocks main thread,
                                 sync-fetch-worker runs async fetchModule(),
                                 Atomics.notify() + receiveMessageOnPort() returns
  → fetch.ts                   — manual redirects (MAX_REDIRECTS=10), writes cache + lock
  → cache.ts writeCache()      — one Deno-format stub per redirect hop + one source entry
  → lock.ts verifyLock()       — checks/updates deno.lock when enabled
```

| File | Role |
|---|---|
| `src/hooks.ts` | Shared sync/async resolve+load logic; `npm:` stripping; `--cdn` bare-specifier mapping (skips node built-ins); `jsr:` → esm.sh mapping; format inference (TypeScript → `module-typescript`); CJS parentURL mangling; `URL_IMPORT_MAIN` entry redirect |
| `src/jsr.ts` | `jsr:` specifier validation and mapping to esm.sh's `/jsr/` endpoint (enabled only when the CDN is esm.sh) |
| `src/loader.ts` | Async hooks for `module.register()`; delegates to hooks.ts |
| `src/register-hooks.ts` | Entry point: `registerHooks()` on Node 22.15+, falls back to `register()` on 18.19+/20.6+ |
| `src/sync-fetch.ts` | Disk-cache check, then blocks via Atomics.wait + persistent worker |
| `src/sync-fetch-worker.ts` | Persistent worker thread running async `fetchModule()` |
| `src/fetch.ts` | Async HTTP fetch, manual redirect tracking, builds full `redirectChain[]` |
| `src/cache.ts` | Deno-compatible cache: `$DENO_DIR/remote/<scheme>/<host>/sha256(pathname)` (macOS default `~/Library/Caches/deno`, Linux `~/.cache/deno`, Windows `%LOCALAPPDATA%\deno`) |
| `src/lock.ts` | Deno lock v5: source hashes, redirect records, frozen mode; lazy-loaded, flushed after each write |
| `src/tmp.ts` | `--tmp` mode: readable tmp paths mirroring URLs + reverse tmp-path → URL map |
| `src/cli.ts` | Parses own flags → env vars, splits/forwards node flags, spawns child `node` |
| `src/progress.ts` | TTY progress bar on stderr during downloads |
| `src/constants.ts` | `NAME`, `MAX_REDIRECTS=10`, `isHttpUrl()` |
| `src/index.ts` | Public API re-exports: `fetchModule`, `clearCache`, `CacheEntry` |

Byte-format compatibility with Deno's remote cache is intentional — Node and Deno share the cache transparently; keep the metadata comment format stable.

## Gotchas

- **Sync hooks**: no async calls inside resolve/load bodies. All blocking funnels through `fetchModuleSync` (Atomics.wait + worker).
- **CJS parentURL mangling**: requiring an HTTP URL from CJS mangles parentURL into a path like `file:///cwd/https:/esm.sh/...`; `extractHttpUrlFromParent` reconstructs the real URL. Changing that regex breaks transitive CJS imports.
- **Worker startup** (sync-fetch.ts): resolve the worker path from `import.meta.url` so both `.ts` (dev) and `.js` (dist) work; never hardcode paths. Create the worker with `execArgv: []` — inherited node flags cause silent hangs.
- **cache.ts / lock.ts**: filesystem operations stay synchronous.
- **CLI entry-point redirect**: an HTTP target makes the CLI set `URL_IMPORT_MAIN` and pass register-hooks as a placeholder entry file; the resolve hook redirects when parentURL is absent, giving the remote module `import.meta.main === true`. Known limit: `process.argv[1]` remains the placeholder path.
- **Remote ESM bundles calling `createRequire(import.meta.url)` fail** — Node's native `createRequire` rejects `https:` URLs (Deno polyfills this; we rely on native behavior). Workaround: import off a CDN that ships a `file:`-friendly build, or use a bundle that avoids that call.

## Node Version Compatibility

| Feature | Min Node |
|---|---|
| `module.register()` (ESM only) | 18.19 / 20.6 |
| `module.registerHooks()` (ESM + CJS) | 22.15 / 23.5 |
| Remote TypeScript (type stripping) | 22.18 |
| CJS `require()` of HTTP URLs | 24 |

Smoke-test before pushing:

```sh
fnm use 18 && node --import ./src/register-hooks.ts -e "import('https://esm.sh/ms')"
fnm use 22 && node --import ./src/register-hooks.ts -e "import('https://esm.sh/ms')"
fnm use 24 && node --import ./src/register-hooks.ts -e "require('https://esm.sh/ms')"
```

## Environment Variables (CLI sets, hooks read)

Hook code reads configuration only through these — never parse CLI flags directly:

| Var | Set by | Effect |
|---|---|---|
| `URL_IMPORT_RELOAD=1` | `-r`/`--reload` | bypass disk cache |
| `URL_IMPORT_TMP=1` | `--tmp` | write modules to readable tmp dir (tmp.ts) |
| `URL_IMPORT_LOCK=path` | `--lock`, `--lock-file <path>`, implied by `--frozen` | enable deno.lock recording/verification |
| `URL_IMPORT_FROZEN=1` | `--frozen` | error when lock out of date, instead of updating |
| `URL_IMPORT_CDN=<url>` | `--cdn[=<url>]` (default `https://esm.sh/`) | map bare specifiers to `<cdn><specifier>`; enables `jsr:` specifiers when esm.sh |
| `URL_IMPORT_MAIN=<url>` | set for an HTTP entry target | redirect entry-point resolution to that URL |
