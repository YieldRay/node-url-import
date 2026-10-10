# node-url-import

Node.js hook that lets you `import` (and `require`) modules directly from HTTP(S) URLs like Deno. Zero runtime dependencies.

```js
import { add } from "https://esm.sh/lodash-es";

console.log(add(1, 2)); // 3
```

```ts
// Remote TypeScript works too (Node 22.18+)
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
```

```js
// CJS require also works (Node 24+)
const { default: ms } = require("https://esm.sh/ms@2.1.3");
console.log(ms("2 days")); // 172800000
```

Works with static imports, dynamic `import()`, CJS `require()`, and relative imports inside remote modules. Fetched modules are cached on disk so subsequent runs are instant.

## Usage

### CLI

Like `ts-node` — a drop-in wrapper around `node` with the hook pre-loaded:

```sh
npm i -g node-url-import
# OR
npx node-url-import

node-url-import [options] [node-flags] [script-or-url] [script-args...]
```

Place node-url-import options first; the remaining arguments are passed unchanged to Node.js. Node handles its own flags and values, `-e`/`-p`, stdin, and script arguments. Use `--` before a filename that starts with `-`.

```sh
# Run a local file that imports from URLs
node-url-import ./app.mjs

# Run a remote URL directly
node-url-import https://raw.esm.sh/armor64/dist/cli.js

# Re-fetch all remote modules (bypass cache)
node-url-import --reload ./app.mjs

# Pass Node.js flags (e.g. --inspect)
node-url-import --inspect ./app.mjs

# Forward flags to the remote script
node-url-import https://raw.esm.sh/nrm-lite/cli.mjs -h

# Resolve bare specifiers via a CDN (e.g. `import "zod"` → https://esm.sh/zod)
node-url-import --cdn ./app.mjs

# Use a custom CDN base
node-url-import --cdn=https://cdn.jsdelivr.net/npm/ ./app.mjs

# Write a lock file (Deno-compatible format)
node-url-import --lock ./app.mjs

# Error if lock file is out of date
node-url-import --lock --frozen ./app.mjs

# Clear the disk cache
node-url-import --clear-cache
```

### Loader hook

Register the hook yourself with `--import`:

```sh
node --import node-url-import/register ./app.mjs
```

On Node 24+, CJS files can `require()` HTTP URLs too:

```sh
node --import node-url-import/register ./app.cjs
```

Or the legacy `--loader` flag (ESM only):

```sh
node --loader node-url-import/loader ./app.mjs
```

### npm: specifiers

`npm:` specifiers check local packages with `require.resolve` first. Local lookup strips the requested version; it does not install or enforce that version. Missing packages fall back to the configured CDN, or `https://esm.sh/`, preserving the version and subpath:

```js
import ms from "npm:ms@2.1.3"; // local: ms; fallback: https://esm.sh/ms@2.1.3
import add from "npm:lodash-es@4/add"; // local: lodash-es/add
import { parse } from "npm:@babel/parser@7"; // local: @babel/parser
```

Remote modules look for local packages from the current working directory. Installed packages use `require` export conditions; export errors do not trigger CDN fallback.

### CDN bare specifiers

With `--cdn`, bare specifiers (package names) are resolved against a CDN base URL instead of `node_modules`, so remote code can import npm packages without a local install:

```js
import { z } from "zod"; // → https://esm.sh/zod
```

- `--cdn` uses the default base `https://esm.sh/`.
- `--cdn=<url>` accepts an HTTP(S) base without query or fragment and adds a trailing `/` if needed, e.g. `--cdn=https://cdn.jsdelivr.net/npm/`.
- Node built-ins (`node:fs`, `http`, `crypto`, …), relative imports (`./x`), and full URLs are left untouched.
- `npm:` still prefers local packages; missing packages use the selected CDN.

### jsr: specifiers

Deno-style `jsr:` specifiers require `--cdn` or an esm.sh CDN base (`--cdn=https://esm.sh/`):

```js
import { encodeBase64 } from "jsr:@std/encoding@1.0.0/base64"; // → https://esm.sh/jsr/@std/encoding@1.0.0/base64
import { Hono } from "jsr:@hono/hono@4"; // → https://esm.sh/jsr/@hono/hono@4
```

### Temporary modules

`--tmp` loads remote modules as local files under `<system-tmp>/node-url-import/session-…/`, so `import.meta.url` is a `file:` URL. Paths mirror the remote URL and include a unique module filename; relative imports retain their original HTTP base, including for extensionless URLs. Session files remain until removed manually or by the OS.

### Programmatic API

```js
import { fetchModule, clearCache } from "node-url-import";

const { source, contentType, finalUrl, redirectChain } = await fetchModule(
  "https://esm.sh/lodash-es/add",
  { signal: AbortSignal.timeout(10_000) },
);
console.log(source);

clearCache(); // synchronous; purges the shared Deno remote cache
```

`fetchModule` returns a `CacheEntry`; `source` is text or `Uint8Array` for Wasm. Network requests default to a 60-second timeout; an explicit `{ signal }` replaces it. Exported types: `FetchOptions`, `CacheEntry`, `ModuleSource`.

## How it works

1. On Node 22.15+, synchronous hooks (`module.registerHooks()`) intercept both `import` and `require` calls for HTTP(S) URLs. On older Node, async hooks (`module.register()`) support ESM `import` only.
2. `resolve` follows up to 10 redirects before choosing the module identity, including for relative imports and CLI entries. `load` reuses the fetched source instead of downloading twice. Node built-ins stay local.
3. Fetched sources use Deno's remote cache (`$DENO_DIR/remote/`, defaulting to `~/Library/Caches/deno/remote/` on macOS and `~/.cache/deno/remote/` on Linux). Writes are atomic; keys include pathname and query, while fragments retain separate module identities.
4. Synchronous hooks serve verified cache hits via `readFileSync`; misses use a persistent network worker and `Atomics.wait`. The wait is bounded to 60 seconds, and failed/timed-out workers can restart.
5. Disk cache entries do not expire. `--reload` bypasses them; `--clear-cache` removes the shared remote cache. Node's in-process module cache still applies.
6. Format comes from `Content-Type` and the final URL, defaulting to ESM. TypeScript uses native type stripping (`.cts` keeps CommonJS semantics); Wasm source stays binary and requires Node's Wasm import support.
7. A Deno-style progress bar is shown on stderr during downloads (only on TTY).

## Known limitations

### `createRequire(import.meta.url)` in remote modules

A remote module's `import.meta.url` is set to its HTTP URL. Node's `module.createRequire()` only accepts a `file:` URL or an absolute path, so a remote ESM bundle that calls `createRequire(import.meta.url)` at load time fails with:

```
TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be a file URL object,
file URL string, or absolute path string. Received 'https://example.com/bundle.js'
```

This affects some bundler outputs (e.g. esbuild ESM bundles of packages like `ws`) even when the resulting `require` is only used for Node built-ins. Deno avoids this by polyfilling `createRequire` to accept remote URLs; this tool relies on Node's native, file-only implementation.

**Workarounds:** use `--tmp` to supply a local `file:` URL, choose a CDN build that avoids the call, or use the local package.

For HTTP CLI entries, `process.argv[1]` is Node's path-normalized entry argument, not the original URL. Use `import.meta.url` for the module location (a local file URL with `--tmp`).

## Node.js version compatibility

| Feature | Minimum Node.js |
|---------|----------------|
| ESM `import` (via `module.register`) | v18.19.0 / v20.6.0 |
| ESM `import` (via `module.registerHooks`) | v22.15.0 / v23.5.0 |
| Remote TypeScript (`.ts`, `.mts`, `.cts`) | v22.18.0 |
| CJS `require` of HTTP URLs | v24+ |

## Options

| Flag                 | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `--reload`          | Bypass cache, re-fetch all remote modules                                  |
| `--lock`             | Check/write a lock file (default: `./deno.lock`)                           |
| `--lock-file <path>` | Lock file path (implies `--lock`)                                          |
| `--frozen`           | Reject missing/changed lock records without updates (implies `--lock`)     |
| `--tmp`              | Load remote modules as readable local temporary files                     |
| `--cdn[=<url>]`      | Map bare packages to a CDN (default: `https://esm.sh/`)                     |
| `--clear-cache`      | Purge the shared Deno remote cache                                         |

Place these options before Node.js flags. `-r` keeps Node's `--require` meaning. Boolean options accept `--flag=false` or `--no-flag`, including `--frozen=false` and `--no-cdn` to override inherited settings.

## Lock file

`--lock` verifies cached and downloaded modules, recording final-source SHA-256 hashes and each redirect hop in Deno's `deno.lock` format. Writes preserve existing npm, JSR and workspace sections:

```json
{
  "version": "5",
  "redirects": {
    "https://raw.esm.sh/armor64/dist/cli.js": "https://raw.esm.sh/armor64@0.1.0/dist/cli.js"
  },
  "remote": {
    "https://raw.esm.sh/armor64@0.1.0/dist/cli.js": "8513c973713ea38737552521eb52529ac880555fbb6fbba8ff8571cec27872c5"
  }
}
```

Hash mismatches always fail, even without `--frozen`. Non-frozen mode adds missing hashes and updates redirects; frozen mode rejects those changes. `--reload` re-fetches source but does not overwrite an existing hash—investigate and deliberately regenerate the lock when changing locked code.

## TypeScript

Remote TypeScript uses Node 22.18+ native type stripping. `.ts`, `.mts` and TypeScript content types use `module-typescript`; `.cts` uses `commonjs-typescript`, including with a TypeScript MIME type. JSX and syntax requiring transpilation are not supported:

```sh
node-url-import https://deno.land/std@0.224.0/path/mod.ts
```

### Type declarations

TypeScript does not resolve `https://` specifiers out of the box. Add an ambient module declaration to a `.d.ts` file included in your `tsconfig.json`:

```ts
declare module 'https://*' {
  const mod: unknown;
  export default mod;
}
```

For named exports or finer-grained types, declare specific remote modules explicitly:

```ts
declare module 'https://esm.sh/lodash-es' {
  export { add, merge } from 'lodash-es';
}
```

## Node.js `--experimental-network-imports`

Node.js v20 shipped a built-in [`--experimental-network-imports`](https://nodejs.org/docs/latest-v20.x/api/cli.html#--experimental-network-imports) flag that allows HTTPS imports without a loader. It was removed in Node.js v22.

## Environment variables

| Variable                  | Description                                                               | Default                         |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------- |
| `DENO_DIR`                | Deno's root cache directory (shared with Deno)                            | `~/Library/Caches/deno` (macOS), `~/.cache/deno` (Linux) |
| `URL_IMPORT_RELOAD=1`     | Same as `--reload`                                                        |                                 |
| `URL_IMPORT_LOCK=<path>`  | Same as `--lock-file <path>`                                               |                                 |
| `URL_IMPORT_FROZEN=1`     | Frozen verification; requires `URL_IMPORT_LOCK`                            |                                 |
| `URL_IMPORT_TMP=1`        | Same as `--tmp`                                                           |                                 |
| `URL_IMPORT_CDN=<base/>`  | Same as `--cdn=<url>`; include the trailing `/`                             |                                 |

Set these variables before registering hooks. The CLI's `--frozen` supplies the default lock path automatically.
