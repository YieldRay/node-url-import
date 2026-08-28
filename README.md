# node-url-import

Node.js hook that lets you `import` (and `require`) modules directly from HTTP(S) URLs like Deno.

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

node-url-import [options] [node-flags] <script-or-url> [script-args...]
```

Flags before the script are split into node-url-import options and Node.js flags.
Flags after the script are forwarded to the remote script as-is.

```sh
# Run a local file that imports from URLs
node-url-import ./app.mjs

# Run a remote URL directly
node-url-import https://raw.esm.sh/armor64/dist/cli.js

# Re-fetch all remote modules (bypass cache)
node-url-import -r ./app.mjs

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

Modules can use Deno-style `npm:` specifiers to import from `node_modules`. The version is stripped and the module is resolved by Node's default resolver:

```js
import ms from "npm:ms";
import ms from "npm:ms@2.1.3"; // version stripped → "ms"
import add from "npm:lodash-es@4/add"; // → "lodash-es/add"
import node from "npm:@types/node@22"; // → "@types/node"
```

### CDN bare specifiers

With `--cdn`, bare specifiers (package names) are resolved against a CDN base URL instead of `node_modules`, so remote code can import npm packages without a local install:

```js
import { z } from "zod"; // → https://esm.sh/zod
```

- `--cdn` uses the default base `https://esm.sh/`.
- `--cdn=<url>` uses a custom base (a trailing `/` is added if missing), e.g. `--cdn=https://cdn.jsdelivr.net/npm/`.
- Node built-ins (`node:fs`, `http`, `crypto`, …), relative imports (`./x`), and full URLs are left untouched.
- `npm:` specifiers still resolve from `node_modules`, regardless of `--cdn`.

### jsr: specifiers

When `--cdn` is specified or set to `https://esm.sh/` (the default), Deno-style `jsr:` specifiers are mapped to esm.sh.

```js
import { encodeBase64 } from "jsr:@std/encoding@1.0.0/base64"; // → https://esm.sh/jsr/@std/encoding@1.0.0/base64
import { Hono } from "jsr:@hono/hono@4"; // → https://esm.sh/jsr/@hono/hono@4
```

### Programmatic API

```js
import { fetchModule, clearCache } from "node-url-import";

const { source, contentType } = await fetchModule(
  "https://esm.sh/lodash-es/add",
);
console.log(source);

await clearCache();
```

## How it works

1. On Node 22.15+, synchronous hooks (`module.registerHooks()`) intercept both `import` and `require` calls for HTTP(S) URLs. On older Node, async hooks (`module.register()`) support ESM `import` only.
2. `resolve` follows redirects to the final URL so that relative imports inside a remote module (e.g. `import "./util.js"`) resolve against the correct base. Bare specifiers like `"node:fs"` fall through to Node's default resolver.
3. Fetched sources are cached in Deno's remote module cache (`$DENO_DIR/remote/`, defaulting to `~/Library/Caches/deno/remote/` on macOS and `~/.cache/deno/remote/` on Linux), using the same file layout as Deno — so both runtimes share the same cache.
4. For `require()` (synchronous), cache hits are served via `readFileSync`. On cache miss, a persistent worker thread fetches asynchronously while the main thread blocks via `Atomics.wait`.
5. Cached modules are used forever until `--reload` is passed or `--clear-cache` is used (same as Deno).
6. Module format is inferred from the `Content-Type` header and URL extension, defaulting to ESM. TypeScript files (`.ts`, `.tsx`, `.mts`, `.cts`) are loaded using Node's built-in type stripping on Node 22.18+.
7. A Deno-style progress bar is shown on stderr during downloads (only on TTY).

## Known limitations

### `createRequire(import.meta.url)` in remote modules

A remote module's `import.meta.url` is set to its HTTP URL. Node's `module.createRequire()` only accepts a `file:` URL or an absolute path, so a remote ESM bundle that calls `createRequire(import.meta.url)` at load time fails with:

```
TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be a file URL object,
file URL string, or absolute path string. Received 'https://example.com/bundle.js'
```

This affects some bundler outputs (e.g. esbuild ESM bundles of packages like `ws`) even when the resulting `require` is only used for Node built-ins. Deno avoids this by polyfilling `createRequire` to accept remote URLs; this tool relies on Node's native, file-only implementation.

**Workarounds:** use `--cdn` (or import directly) from a CDN that ships a build which doesn't call `createRequire(import.meta.url)`, or use the package's `node_modules` build.

## Node.js version compatibility

| Feature | Minimum Node.js |
|---------|----------------|
| ESM `import` (via `module.register`) | v18.19.0 / v20.6.0 |
| ESM `import` (via `module.registerHooks`) | v22.15.0 / v23.5.0 |
| Remote TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`) | v22.18.0 |
| CJS `require` of HTTP URLs | v24+ |

## Options

| Flag                 | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `-r, --reload`       | Bypass cache, re-fetch all remote modules                                  |
| `--lock`             | Check/write a lock file (default: `./deno.lock`)                           |
| `--lock-file <path>` | Lock file path (implies `--lock`)                                          |
| `--frozen`           | Error if lock file is out of date (use with `--lock`)                      |
| `--tmp`              | Write fetched modules to a tmp dir with readable paths (CLI only)          |
| `--clear-cache`      | Purge the disk cache                                                       |

Any unrecognized flags before the script are forwarded to Node.js (e.g. `--inspect`, `--env-file`).

## Lock file

When `--lock` is passed, node-url-import writes a lock file recording the SHA-256 hash of every fetched remote module. The format is compatible with Deno's `deno.lock`:

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

On subsequent runs with `--lock`, fetched content is verified against the recorded hashes. Use `--frozen` to error on any mismatch instead of updating.

## TypeScript

Remote TypeScript modules are supported on Node 22.18+ via Node's built-in type stripping. Files with `.ts`, `.tsx`, `.mts`, or `.cts` extensions (and URLs served with `text/typescript` or `application/typescript` content-type) are automatically loaded with the `module-typescript` format:

```sh
node-url-import https://deno.land/std@0.224.0/path/mod.ts
```

### Type declarations

TypeScript does not resolve `https://` specifiers out of the box. Add an ambient module declaration to a `.d.ts` file included in your `tsconfig.json`:

```ts
declare module 'https://*' {
  const mod: unknown;
  export default mod;
  export * from 'module';
}
```

For finer-grained types, declare specific remote modules explicitly:

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
| `URL_IMPORT_LOCK=<path>`  | Same as `--lock <file>`                                                   |                                 |
| `URL_IMPORT_FROZEN=1`     | Same as `--frozen`                                                        |                                 |
| `URL_IMPORT_TMP=1`        | Same as `--tmp`                                                           |                                 |
