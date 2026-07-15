/**
 * Shared resolve + load hook logic, parameterized by the fetch function.
 *
 * - For module.registerHooks() (sync): uses fetchModuleSync
 * - For module.register() (async, in loader worker): uses fetchModule (async)
 *
 * Exported factory functions createResolve/createLoad produce the hook
 * functions. Also exports ready-made sync versions for registerHooks.
 */

import type { ResolveHookContext, ResolveFnOutput, LoadHookContext, LoadFnOutput, ResolveHookSync, LoadHookSync } from "node:module";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { fetchModuleSync } from "./sync-fetch.ts";
import { isHttpUrl } from "./constants.ts";
import { tmpEnabled, urlToTmpPath, writeTmpFile, tmpPathToUrl } from "./tmp.ts";
import type { CacheEntry } from "./cache.ts";

/**
 * Strip `npm:` prefix and optional `@version` from an npm specifier.
 *   npm:ms@2.1.3           → ms
 *   npm:@scope/pkg@1.0.0   → @scope/pkg
 *   npm:@scope/pkg@1.0.0/s → @scope/pkg/s
 *   npm:lodash-es          → lodash-es
 */
export function stripNpmSpecifier(specifier: string): string {
  let bare = specifier.slice(4); // remove "npm:"

  // For scoped packages (@scope/pkg@version), the version @ is after the first /
  // For unscoped packages (pkg@version), the version @ is the first @
  const isScoped = bare.startsWith("@");
  const versionAtIdx = isScoped
    ? bare.indexOf("@", bare.indexOf("/") + 1)
    : bare.indexOf("@");

  if (versionAtIdx > 0) {
    const afterAt = bare.indexOf("/", versionAtIdx);
    if (afterAt > 0) {
      // @scope/pkg@version/subpath → @scope/pkg/subpath
      bare = bare.slice(0, versionAtIdx) + bare.slice(afterAt);
    } else {
      // @scope/pkg@version → @scope/pkg
      bare = bare.slice(0, versionAtIdx);
    }
  }

  return bare;
}

/**
 * When CJS code does `require("https://...")`, Node's registerHooks resolves the
 * URL but then internally converts it to a file path for the CJS module system.
 * For example, `https://esm.sh/ms@2.1.3` becomes a parentURL like:
 *   file:///cwd/https:/esm.sh/ms@2.1.3
 *
 * We detect this pattern and reconstruct the original HTTP URL so transitive
 * relative imports (e.g., `/ms@2.1.3/es2022/ms.mjs`) resolve correctly.
 */
function extractHttpUrlFromParent(parentURL: string): string | null {
  const match = parentURL.match(/\/(https?:)\/([^/].*)$/);
  if (match) {
    return `${match[1]}//${match[2]}`;
  }
  return null;
}

/**
 * Get the effective HTTP parent URL from context.parentURL.
 * Returns the parentURL as-is if it's already HTTP, reconstructs it if mangled,
 * or returns null if it's a normal file URL.
 */
function getHttpParentUrl(parentURL: string | undefined): string | null {
  if (!parentURL) return null;
  if (isHttpUrl(parentURL)) return parentURL;
  return extractHttpUrlFromParent(parentURL);
}

/**
 * Whether the running Node version supports the "module-typescript" /
 * "commonjs-typescript" load formats natively (without flags).
 * Type stripping is enabled by default in Node 22.18+ and 23+/24+.
 * @see https://nodejs.org/docs/latest-v22.x/api/cli.html#--no-experimental-strip-types
 */
const supportsTypeScriptFormat: boolean = (() => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 18);
})();

/**
 * Resolve the load format for a TypeScript source. On Node versions without
 * native type stripping (< 22.18), returning "module"/"commonjs" would hand
 * raw TypeScript to the parser and fail with a cryptic syntax error, so we
 * throw an explicit, actionable error instead.
 */
function typeScriptFormat(url: string, commonjs: boolean, tsSupported: boolean): string {
  if (!tsSupported) {
    throw new Error(
      `Cannot load remote TypeScript module ${url}: this Node version ` +
        `(${process.versions.node}) does not support type stripping. ` +
        `Upgrade to Node 22.18+ or 24+ to import remote TypeScript.`,
    );
  }
  return commonjs ? "commonjs-typescript" : "module-typescript";
}

/**
 * `tsSupported` is injectable for testing; it defaults to the running Node
 * version's native type-stripping support.
 */
export function inferFormat(
  url: string,
  contentType: string,
  tsSupported: boolean = supportsTypeScriptFormat,
): string {
  const ct = contentType.toLowerCase();

  if (ct.includes("application/json")) return "json";
  if (ct.includes("application/wasm")) return "wasm";
  if (ct.includes("text/typescript") || ct.includes("application/typescript"))
    return typeScriptFormat(url, false, tsSupported);

  const pathname = new URL(url).pathname;
  if (pathname.endsWith(".json")) return "json";
  if (pathname.endsWith(".wasm")) return "wasm";
  if (pathname.endsWith(".cts")) return typeScriptFormat(url, true, tsSupported);
  if (pathname.endsWith(".cjs")) return "commonjs";
  if (pathname.endsWith(".mts")) return typeScriptFormat(url, false, tsSupported);
  if (pathname.endsWith(".mjs")) return "module";
  if (pathname.endsWith(".ts") || pathname.endsWith(".tsx"))
    return typeScriptFormat(url, false, tsSupported);

  return "module";
}

// Infer NextResolve/NextLoad from Node's sync hook types
type NextResolve = Parameters<ResolveHookSync>[2];
type NextLoad = Parameters<LoadHookSync>[2];

// Async hook types (same params as sync, but return Promise)
type ResolveHookAsync = (...args: Parameters<ResolveHookSync>) => Promise<ResolveFnOutput>;
type LoadHookAsync = (...args: Parameters<LoadHookSync>) => Promise<LoadFnOutput>;

/**
 * The HTTP URL to treat as the main entry module. When set, the resolve hook
 * redirects the entry-point file resolution to this URL so that
 * import.meta.main is true and import.meta.url reflects the remote URL.
 * Set by the CLI via the URL_IMPORT_MAIN environment variable.
 */
const mainUrl: string | undefined = process.env.URL_IMPORT_MAIN;

/**
 * Create a resolve hook parameterized by the fetch function.
 * Sync fetchFn produces ResolveHookSync, async produces ResolveHookAsync.
 */
export function createResolve(fetchFn: (url: string) => CacheEntry): ResolveHookSync;
export function createResolve(fetchFn: (url: string) => Promise<CacheEntry>): ResolveHookAsync;
export function createResolve(fetchFn: (url: string) => CacheEntry | Promise<CacheEntry>) {
  return function resolve(
    specifier: string,
    context: ResolveHookContext,
    nextResolve: NextResolve,
  ): ResolveFnOutput | Promise<ResolveFnOutput> {
    // Entry-point redirect: when the CLI sets URL_IMPORT_MAIN, the first
    // resolve call (parentURL is undefined) for the dummy entry file is
    // redirected to the HTTP URL so Node treats it as the main module.
    if (mainUrl && !context.parentURL && !isHttpUrl(specifier)) {
      return { shortCircuit: true, url: mainUrl };
    }

    // npm: specifier — strip prefix and version, let Node resolve from node_modules.
    if (specifier.startsWith("npm:")) {
      return nextResolve(stripNpmSpecifier(specifier), context);
    }

    // Direct HTTP(S) URL
    if (isHttpUrl(specifier)) {
      const result = fetchFn(specifier);

      const handleFetched = (entry: CacheEntry): ResolveFnOutput => {
        if (tmpEnabled) {
          const tmpPath = urlToTmpPath(entry.finalUrl, entry.contentType);
          writeTmpFile(tmpPath, entry.source);
          const format = inferFormat(entry.finalUrl, entry.contentType);
          return { shortCircuit: true, url: pathToFileURL(tmpPath).href, format };
        }
        return { shortCircuit: true, url: entry.finalUrl };
      };

      if (result instanceof Promise) {
        return result.then(handleFetched);
      }
      return handleFetched(result);
    }

    // --tmp mode: relative import inside a module under the tmp dir
    if (
      tmpEnabled &&
      context.parentURL &&
      (specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier.startsWith("/"))
    ) {
      const parentHttpUrl = tmpPathToUrl(context.parentURL);
      if (parentHttpUrl) {
        const resolved = new URL(specifier, parentHttpUrl).href;
        const result = fetchFn(resolved);

        const handleFetched = (entry: CacheEntry): ResolveFnOutput => {
          const tmpPath = urlToTmpPath(entry.finalUrl, entry.contentType);
          writeTmpFile(tmpPath, entry.source);
          const format = inferFormat(entry.finalUrl, entry.contentType);
          return { shortCircuit: true, url: pathToFileURL(tmpPath).href, format };
        };

        if (result instanceof Promise) {
          return result.then(handleFetched);
        }
        return handleFetched(result);
      }
    }

    // Relative or absolute-path import inside an HTTP-loaded module.
    // Also handles the case where Node mangles HTTP URLs into file paths for CJS require.
    if (
      context.parentURL &&
      (specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier.startsWith("/"))
    ) {
      const httpParent = getHttpParentUrl(context.parentURL);
      if (httpParent) {
        const resolved = new URL(specifier, httpParent).href;
        return { shortCircuit: true, url: resolved };
      }
    }

    return nextResolve(specifier, context);
  };
}

/**
 * Create a load hook parameterized by the fetch function.
 * Sync fetchFn produces LoadHookSync, async produces LoadHookAsync.
 */
export function createLoad(fetchFn: (url: string) => CacheEntry): LoadHookSync;
export function createLoad(fetchFn: (url: string) => Promise<CacheEntry>): LoadHookAsync;
export function createLoad(fetchFn: (url: string) => CacheEntry | Promise<CacheEntry>) {
  return function load(
    url: string,
    context: LoadHookContext,
    nextLoad: NextLoad,
  ): LoadFnOutput | Promise<LoadFnOutput> {
    if (isHttpUrl(url)) {
      const result = fetchFn(url);

      const handleFetched = (entry: CacheEntry): LoadFnOutput => {
        const format = inferFormat(url, entry.contentType);
        return { shortCircuit: true, format, source: entry.source };
      };

      if (result instanceof Promise) {
        return result.then(handleFetched);
      }
      return handleFetched(result);
    }

    return nextLoad(url, context);
  };
}

// Ready-made sync hooks for module.registerHooks()
export const resolve = createResolve(fetchModuleSync);
export const load = createLoad(fetchModuleSync);
