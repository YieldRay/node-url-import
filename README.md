# node-url-import

Node.js hook that lets you `import` modules directly from HTTP(S) URLs.

```js
import { add } from "https://esm.sh/lodash-es@4.17.21";

console.log(add(1, 2)); // 3
```

Works with static imports, dynamic `import()`, and relative imports inside remote modules. Fetched modules are cached on disk so subsequent runs are instant.

## Usage

### CLI

Like `tsx` — a drop-in wrapper around `node` with the hook pre-loaded:

```sh
# Run a local file that imports from URLs
node-url-import ./app.mjs

# Run a remote URL directly
node-url-import https://raw.esm.sh/armor64/dist/cli.js

# Re-fetch all remote modules (bypass cache)
node-url-import -r ./app.mjs

# Write a lock file (Deno-compatible format)
node-url-import --lock ./app.mjs

# Error if lock file is out of date
node-url-import --lock --frozen ./app.mjs

# Clear the disk cache
node-url-import --clear-cache
```

### Loader hook

Register the hook yourself with `--import` (Node >= 18.19):

```sh
node --import node-url-import/register ./app.mjs
```

Or the legacy `--loader` flag:

```sh
node --loader node-url-import/loader ./app.mjs
```

### npm: specifiers

Modules can use Deno-style `npm:` specifiers to import from `node_modules`:

```js
import ms from "npm:ms";
```

The `npm:` prefix is stripped and the module is resolved by Node's default resolver.

### Programmatic API

```js
import { fetchModule, clearCache } from "node-url-import";

const { source, contentType } = await fetchModule(
  "https://esm.sh/lodash-es@4.17.21/add",
);
console.log(source);

await clearCache();
```

## How it works

1. The ESM loader hooks (`resolve` + `load`) intercept any specifier starting with `http://` or `https://`.
2. Relative imports inside remote modules (e.g. `import "./util.js"` from `https://esm.sh/...`) resolve back to the same origin. Bare specifiers like `"node:fs"` fall through to Node's default resolver.
3. Fetched sources are cached at `~/.cache/node-url-import/` keyed by SHA-256 of the URL.
4. Cached modules are used forever until `--reload` is passed or `--clear-cache` is used (same as Deno).
5. Module format is inferred from the `Content-Type` header and URL extension, defaulting to ESM.

## Options

| Flag            | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `-r, --reload`  | Bypass cache, re-fetch all remote modules                                  |
| `--lock [file]` | Check/write a lock file (default: `./deno.lock`)                           |
| `--frozen`      | Error if lock file is out of date (use with `--lock`)                      |
| `--local-meta`  | Rewrite `import.meta.url` to a local `file://` URL (fixes `createRequire`) |
| `--clear-cache` | Purge the disk cache                                                       |

## Lock file

When `--lock` is passed, node-url-import writes a lock file recording the SHA-256 hash of every fetched remote module. The format is compatible with Deno's `deno.lock`:

```json
{
  "version": "5",
  "remote": {
    "https://esm.sh/ms@2.1.3": "05ddb185b1d26c888c647f2aaac723379f0933fb608b3a9a994e602c41900019"
  }
}
```

On subsequent runs with `--lock`, fetched content is verified against the recorded hashes. Use `--frozen` to error on any mismatch instead of updating.

## Environment variables

| Variable                 | Description             | Default                    |
| ------------------------ | ----------------------- | -------------------------- |
| `URL_IMPORT_CACHE_DIR`   | Custom cache directory  | `~/.cache/node-url-import` |
| `URL_IMPORT_RELOAD=1`    | Same as `--reload`      |                            |
| `URL_IMPORT_LOCK=<path>` | Same as `--lock <file>` |                            |
| `URL_IMPORT_FROZEN=1`    | Same as `--frozen`      |                            |
| `URL_IMPORT_META=file`   | Same as `--local-meta`  |                            |

## Requirements

Node.js >= 22
