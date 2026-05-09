# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
# Build (TypeScript → dist/)
npm run build         # tsc --declaration

# Run tests (uses the hook itself to load .ts test files)
npm test              # node --import ./src/register.ts --test src/*.test.ts

# Type-check without emitting
npm run typecheck     # tsc --noEmit

# Run the CLI directly from source (no build needed)
npm run cli -- [args] # node src/cli.ts
```

Node v18.19+ or v20.6+ is required for `module.register()` (the `--import` flag path). Older Node versions fall back to `--loader` / `--experimental-loader`.

## Architecture

The package is a Node.js ESM loader hook that lets scripts `import` modules directly from HTTP(S) URLs, mirroring Deno's behaviour.

**Data flow on first load:**
```
import "https://…"
  → loader.ts resolve()    — calls fetchModule() to follow redirects; returns finalUrl as the
                             canonical URL so relative imports inside the module resolve correctly
  → loader.ts load()       — calls fetchModule() (cache hit), infers format, optionally patches import.meta.url
  → fetch.ts fetchModule() — follows redirects manually (up to MAX_REDIRECTS=10), writes cache + lock
  → cache.ts writeCache()  — writes one Deno-format file per redirect hop + one source entry
  → lock.ts verifyLock()   — checks/updates deno.lock if --lock is active
```

**Key modules:**

| File | Role |
|---|---|
| `src/loader.ts` | ESM `resolve` + `load` hooks; `npm:` specifier stripping; format inference |
| `src/register.ts` | Entry point for `--import` flag; calls `module.register()` to install loader in a worker thread |
| `src/fetch.ts` | HTTP fetch with manual redirect tracking; builds full `redirectChain[]` for cache |
| `src/cache.ts` | Deno-compatible disk cache at `$DENO_DIR/remote/`; files keyed by `sha256(url.pathname)` per host |
| `src/lock.ts` | Deno-compatible lock file (version 5); lazy-loaded, flushed after each write |
| `src/cli.ts` | CLI wrapper: parses own flags, forwards unknown flags to Node, spawns child `node` process |
| `src/progress.ts` | TTY progress bar shown on stderr during downloads |
| `src/constants.ts` | `NAME`, `MAX_REDIRECTS`, `isHttpUrl()` |
| `src/index.ts` | Public programmatic API re-exports |

**Three entry points in `package.json` exports:**
- `.` → `dist/index.js` — programmatic API (`fetchModule`, `clearCache`, etc.)
- `./loader` → `dist/loader.js` — legacy `--loader` flag
- `./register` → `dist/register.js` — modern `--import` flag

**Cache format:** Identical to Deno's remote module cache. Directory: `$DENO_DIR/remote/<scheme>/<host>/` (respects `DENO_DIR` env var; defaults to `~/Library/Caches/deno/remote` on macOS, `~/.cache/deno/remote` on Linux). Filename: `sha256(url.pathname)` (hex). Redirect stubs: whole file is `\n// denoCacheMetadata=<JSON>`. Source entries: `<raw source>\n// denoCacheMetadata=<JSON>` appended at end. Node and Deno share the same cache transparently.

**TypeScript setup:** Uses Node's native type-stripping (no ts-node). Source files use `.ts` extensions in imports. `erasableSyntaxOnly: true` means no enums or namespaces. Build emits `.js` + `.d.ts` to `dist/`.

**CLI flag forwarding:** The CLI spawns a child `node` process rather than running inline. Own flags (`--reload`, `--lock`, etc.) are translated to environment variables (`URL_IMPORT_RELOAD`, `URL_IMPORT_LOCK`, etc.) so the loader thread picks them up.
