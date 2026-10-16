# node-url-import

Import HTTP(S) modules in Node.js, like Deno. Supports static imports, dynamic `import()`, CJS `require()`, and remote relative imports. Zero runtime dependencies.

```js
import { add } from "https://esm.sh/lodash-es";
console.log(add(1, 2)); // 3
```

## Usage

```sh
npm i -g node-url-import
# Or: npx node-url-import [args]

node-url-import [options] [node-flags] [script-or-url] [script-args...]
```

Put loader options first; the remaining arguments go to Node unchanged. Use `--` before filenames beginning with `-`.

```sh
node-url-import ./app.mjs
node-url-import https://raw.esm.sh/armor64/dist/cli.js -h
node-url-import --cdn --inspect ./app.mjs
node-url-import --lock --frozen ./app.mjs
```

| Option | Environment variable | Description |
| --- | --- | --- |
| `--reload` | `URL_IMPORT_RELOAD=1` | Bypass disk cache |
| `--lock` | `URL_IMPORT_LOCK=<path>` | Check/write `./deno.lock` |
| `--lock-file <path>` | `URL_IMPORT_LOCK=<path>` | Use a custom lock path |
| `--frozen` | `URL_IMPORT_FROZEN=1` | Reject lock changes |
| `--tmp` | `URL_IMPORT_TMP=1` | Load readable local files; `import.meta.url` becomes a `file:` URL |
| `--cdn[=<url>]` | `URL_IMPORT_CDN=<base/>` | Resolve missing bare packages via a CDN (default: `https://esm.sh/`) |
| `--clear-cache` | — | Purge the shared remote cache |

Boolean options are flag-only: boolean values and `--no-*` forms are unsupported. Set environment variables before registration; use `0` to disable inherited booleans, or unset CDN/lock variables to disable those settings.

Register without the CLI:

```sh
node --import node-url-import/register ./app.mjs
node --import node-url-import/register ./app.cjs
node --loader node-url-import/loader ./app.mjs # Legacy, ESM only
```

| Feature | Minimum Node.js |
| --- | --- |
| ESM imports | 18.19 / 20.6 |
| Remote TypeScript | 22.18 |
| CJS `require()` of HTTP URLs | 24 |

## Imports

### `npm:`

Local packages use `require.resolve`, ignoring the requested version. Missing packages fall back to the configured CDN (or esm.sh), preserving version and subpath. Export errors do not trigger fallback. Remote modules look up local packages from the working directory.

```js
import ms from "npm:ms@2.1.3";
import add from "npm:lodash-es@4/add";
import { parse } from "npm:@babel/parser@7";
```

### CDN, `jsr:`, and JSON

`--cdn` checks `node_modules` first and resolves missing bare packages from a CDN. Custom HTTP(S) bases must omit query/fragment; a trailing `/` is added. Built-ins, paths, full URLs, and `#imports` are not CDN-mapped. `jsr:` requires an esm.sh base; ESM JSON requires `type: "json"`.

```js
import { z } from "zod"; // --cdn → local zod, else https://esm.sh/zod
import { encodeBase64 } from "jsr:@std/encoding@1.0.0/base64";
import data from "https://example.com/data.json" with { type: "json" };
```

## Cache and lock

Shares **Deno 2.9.7** remote-cache and v5 lock formats only; older layouts are not read or migrated. Cache location: `$DENO_DIR/remote/`, defaulting to `~/Library/Caches/deno/remote/` on macOS and `~/.cache/deno/remote/` on Linux. Entries do not expire; Node's in-process module cache still applies.

Cache keys include queries but exclude fragments; full URLs identify modules and lock records. Redirects use Deno's URL-join rules: `Location` without `#` drops the request fragment. Relative imports use the final URL, with up to 10 redirect hops.

Enable locking with `--lock` or a configured lock path. Hash mismatches always fail; `--frozen` rejects missing/changed records. `--reload` neither overwrites hashes nor repins redirects. Unrelated Deno lock sections are preserved.

Explicit `--frozen` supplies `./deno.lock` if no path is configured. `URL_IMPORT_FROZEN=1` alone does not enable locking.

## Programmatic API

```js
import { fetchModule, clearCache } from "node-url-import";

const { source, contentType, finalUrl, redirectChain } = await fetchModule(
  "https://esm.sh/lodash-es/add",
  { signal: AbortSignal.timeout(10_000) },
);
console.log(source);
clearCache(); // Synchronously purges the shared remote cache
```

## Limitations

- TypeScript uses native type stripping; `.cts` retains CommonJS semantics.
- Bundles calling `createRequire(import.meta.url)` fail on HTTP URLs. Use `--tmp`, a compatible CDN build, or a local package. Temporary files remain until manually removed or cleaned by the OS.
- For remote CLI entries, `process.argv[1]` is path-normalized; use `import.meta.url` for the module location.

TypeScript needs ambient declarations for URL imports. Add them to an included `.d.ts` file, for example:

```ts
declare module "https://esm.sh/lodash-es" {
  export { add, merge } from "lodash-es";
}
```
