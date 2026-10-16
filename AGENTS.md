# AGENTS.md

## Workflow

Use Node 24+ for source development. Run typecheck → build → test:

```sh
npm run typecheck
npm run build
npm test
npm run cli -- [args]
```

Single-file tests: `node --import ./src/register-hooks.ts --test src/hooks.test.ts`.
Use local HTTP servers and isolated cache/tmp fixtures; never clear the user's shared cache. Report public-CDN failures separately from regressions.

## Conventions

- Zero runtime dependencies; use Node's standard library.
- Follow `tsconfig.json`: erasable TypeScript, `.ts` relative imports, `import type` for type-only imports.
- Prefer overloads/generics over casts. Casts are acceptable at untyped parseArgs/worker-message boundaries.
- Keep `createResolve`/`createLoad` implementation return types unannotated; overloads provide concrete caller types.
- Preserve useful protocol/format comments. Keep docs concise: user-facing usage in README, internal invariants here; avoid repeating implied behavior.
- Commit only when requested, using single-line Conventional Commits.

## Architecture

Resolve chooses the final URL before Node assigns module identity; load reuses the verified source through `pendingLoads`.

| Files | Responsibility |
| --- | --- |
| `hooks.ts` | Shared sync/async resolution, format and attribute validation |
| `register-hooks.ts`, `loader.ts` | Sync registration or async loader initialization |
| `fetch.ts` | Locked redirects, HTTP fetch, verification, cache publication |
| `sync-fetch.ts`, `sync-fetch-worker.ts` | Blocking facade over a persistent network worker |
| `cache.ts` | Deno cache paths, text decoding, atomic writes |
| `lock.ts` | v5 verification and canonical-target transactions |
| `tmp.ts` | Readable module files and exact reverse URL mapping |
| `cli.ts` | Leading own options, unchanged Node arguments, child lifecycle |
| `jsr.ts` | esm.sh-only `jsr:` mapping |

## Invariants

### Hooks and CLI

- Sync hooks block only through `fetchModuleSync`. Worker startup resolves `.ts`/`.js` from `import.meta.url` with `execArgv: []`. Error callbacks cannot run during `Atomics.wait`; retain the 60-second bound and discard timed-out workers. Post results before notifying.
- Resolve redirects before load, reusing `pendingLoads` even with reload. Preserve the CJS parent reconstruction regex for `file:///cwd/https:/host/...`.
- `npm:` strips versions only for local `require.resolve`, anchored to a local caller or the working directory. Only `MODULE_NOT_FOUND` falls back to the CDN. Keep built-ins and `#imports` native. `--cdn` bare specifiers resolve natively first with the same anchoring; only module-not-found (`MODULE_NOT_FOUND`/`ERR_MODULE_NOT_FOUND`) falls back to the CDN.
- Validate import attributes before publishing tmp files and when loading source. ESM JSON requires type `json`; native require(JSON) omits `context.importAttributes`. User-configurable `conditions` cannot identify require.
- Tmp reverse mapping stores exact URLs, including query/fragment; synthetic filenames cannot recover relative-import bases.
- Consume/delete `URL_IMPORT_MAIN` and `URL_IMPORT_MAIN_CANDIDATES` before creating Workers. Carry `mainUrl` as local hook/loader data; redirect only the exact parentless placeholder once.
- Node captures async hook exports before `initialize()`. Keep exported `resolve` stable and configure its private delegate.
- Own CLI booleans are flag-only; use `parseArgs` without `allowNegative`. Forward the remaining Node arguments unchanged. Use async `spawn`; forward termination signals, await handled exits, and re-raise POSIX signal exits after removing handlers.
- Read configuration from env before registration. Only explicit CLI `--frozen` supplies a default lock path; inherited frozen alone does not enable a lock.

### Deno compatibility

Target **Deno 2.9.7 only**; no older cache readers or migration.

- Canonicalize URLs before cache/network access. Join `Location` directly: absent fragments are dropped; explicit fragments and trailing `#` survive. Apply locked redirects even with reload; limit the combined chain to 10 hops.
- Cache authority: escape `_` as `%5f`, use `_port_<port>`, retain bracketed IPv6. Above 250 characters, use `#sha256(unescaped host[:port])`. Hash pathname + query, including a bare `?`; omit fragments from disk keys.
- Keep `<response bytes>\n// denoCacheMetadata=<JSON>` and full canonical metadata URLs. Cache original bytes; cached 404/incomplete entries are misses.
- Decode text with the declared WHATWG charset (default UTF-8, no BOM sniffing), strip one decoded leading BOM, then hash. Wasm bytes stay untouched.
- Filesystem operations remain synchronous. Atomic writes use sibling temp files; restore existing modes with `fchmodSync` before fsync/rename. New files respect umask.
- Lock, reload, merge and replace the same canonical target, following symlinks. Sort remote/redirect keys; preserve unrelated sections. Verify source and every hop before publication; never write a thread-local snapshot.
- Lock keys/targets retain queries and fragments. Hash mismatches always fail; frozen rejects missing/changed records only with an enabled lock path. Reload neither repins redirects nor overwrites hashes.

## Compatibility checks

- Registration changes: smoke-test compiled `dist/` with isolated `DENO_DIR` on Node 18/20/22 (ESM) and 24 (CJS).
- Retain regressions for CLI → local Worker, captured async initialization, JSON attributes/custom conditions/require, URL aliases, charset bytes, file modes and symlink-alias concurrent locks.
- Deno interop: use 2.9.7, compare v5 locks both ways, require zero-network `--cached-only` loads for BOM-free UTF-8. Deno can reject its own frozen locks when decoding/BOM removal changes bytes; preserve integrity errors rather than rewriting hashes.
