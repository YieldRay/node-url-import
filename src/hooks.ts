/**
 * Shared resolve + load hook logic, parameterized by the fetch function.
 *
 * - module.registerHooks() uses fetchModuleSync for import and require.
 * - module.register() uses fetchModule in Node's asynchronous loader thread.
 *
 * The factories share URL normalization and format inference while their
 * overloads keep synchronous and asynchronous callers correctly typed.
 */

import type {
  ResolveHookContext, ResolveFnOutput, LoadHookContext, LoadFnOutput, ResolveHookSync, LoadHookSync,
} from "node:module";
import { createRequire, isBuiltin } from "node:module";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { fetchModuleSync } from "./sync-fetch.ts";
import { DEFAULT_CDN, isHttpUrl } from "./constants.ts";
import { isEsmShCdn, jsrToCdnUrl } from "./jsr.ts";
import { tmpEnabled, urlToTmpPath, writeTmpFile, tmpPathToUrl } from "./tmp.ts";
import { verifyModuleLock } from "./lock.ts";
import type { CacheEntry } from "./cache.ts";

/**
 * Strip `npm:` and the optional version for local Node package resolution.
 *   npm:ms@2.1.3             → ms
 *   npm:@scope/pkg@1.0.0     → @scope/pkg
 *   npm:@scope/pkg@1.0.0/sub → @scope/pkg/sub
 *   npm:lodash-es           → lodash-es
 * The original version is kept when an uninstalled package falls back to a CDN.
 */
export function stripNpmSpecifier(specifier: string): string {
  return specifier.slice(4).replace(/^(@[^/]+\/[^/@]+|[^/@]+)@[^/]+/, "$1");
}

/**
 * Recover the HTTP parent for normal URL imports, --tmp modules and CJS.
 * Node's CJS loader mangles https://esm.sh/pkg into file:///cwd/https:/esm.sh/pkg;
 * reconstructing it keeps transitive relative requires on the remote server.
 */
function getHttpParentUrl(parentURL: string | undefined): string | null {
  if (!parentURL) return null;
  if (isHttpUrl(parentURL)) return parentURL;
  const temporaryUrl = tmpEnabled ? tmpPathToUrl(parentURL) : null;
  if (temporaryUrl) return temporaryUrl;
  // CJS normalizes https://host/path into file:///cwd/https:/host/path.
  const match = parentURL.match(/\/(https?:)\/([^/].*)$/);
  return match ? `${match[1]}//${match[2]}` : null;
}

/** Whether this Node version enables native TypeScript load formats by default. */
const supportsTypeScriptFormat = (() => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 18);
})();

/**
 * Resolve the load format for TypeScript. Older Node versions cannot strip
 * types, so fail explicitly rather than handing raw TypeScript to the JS parser.
 * .cts must keep CommonJS semantics even when served with a TypeScript MIME type.
 */
function typeScriptFormat(url: string, commonjs: boolean, supported: boolean): string {
  if (!supported) {
    throw new Error(`Cannot load remote TypeScript module ${url}: this Node version (${process.versions.node}) ` +
      "does not support type stripping. Upgrade to Node 22.18+ or 24+.");
  }
  return commonjs ? "commonjs-typescript" : "module-typescript";
}

/**
 * Infer the module format from Content-Type and the final URL's extension.
 * tsSupported is injectable for tests and otherwise follows the running Node.
 */
export function inferFormat(url: string, contentType: string, tsSupported = supportsTypeScriptFormat): string {
  const type = contentType.toLowerCase();
  const pathname = new URL(url).pathname;
  if (type.includes("application/json")) return "json";
  if (type.includes("application/wasm")) return "wasm";
  if (pathname.endsWith(".cts")) return typeScriptFormat(url, true, tsSupported);
  if (type.includes("text/typescript") || type.includes("application/typescript")) {
    return typeScriptFormat(url, false, tsSupported);
  }
  if (pathname.endsWith(".json")) return "json";
  if (pathname.endsWith(".wasm")) return "wasm";
  if (pathname.endsWith(".cjs")) return "commonjs";
  if (/\.(?:ts|tsx|mts)$/.test(pathname)) return typeScriptFormat(url, false, tsSupported);
  return "module";
}

type NextResolve = Parameters<ResolveHookSync>[2];
type NextLoad = Parameters<LoadHookSync>[2];
type ResolveHookAsync = (...args: Parameters<ResolveHookSync>) => Promise<ResolveFnOutput>;
type LoadHookAsync = (...args: Parameters<LoadHookSync>) => Promise<LoadFnOutput>;

/** CLI entry redirect: make the remote module the real import.meta.main entry. */
const mainUrl = process.env.URL_IMPORT_MAIN;
/** Bare packages map to this CDN; npm: still checks node_modules first. */
const cdnBase = process.env.URL_IMPORT_CDN;
/** A leading scheme excludes node:, data:, file:, npm: and other full URLs. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const projectParentUrl = (): string => pathToFileURL(resolvePath(process.cwd(), "package.json")).href;
// Hand the already-fetched source from resolve to load, including with --reload.
const pendingLoads = new Map<string, CacheEntry>();

/** Relative and absolute-path imports resolve against the effective HTTP parent. */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

/** Package names such as ws or @scope/pkg/sub, excluding paths and URL schemes. */
function isBareSpecifier(specifier: string): boolean {
  return !isRelativeSpecifier(specifier) && !SCHEME_RE.test(specifier);
}

/** Use require.resolve for npm: packages, anchored to a local caller or the project. */
function resolveLocalPackage(specifier: string, context: ResolveHookContext, nextResolve: NextResolve): ResolveFnOutput {
  const parentURL = context.parentURL && !getHttpParentUrl(context.parentURL) ? context.parentURL : projectParentUrl();
  if (isBuiltin(specifier)) return nextResolve(specifier, { ...context, parentURL });
  const resolved = createRequire(parentURL).resolve(specifier);
  return nextResolve(pathToFileURL(resolved).href, { ...context, parentURL });
}

/**
 * Create a resolve hook. Sync fetch functions produce sync hooks; async fetch
 * functions produce async hooks. All HTTP paths follow redirects before Node
 * chooses a module identity, so its relative imports use the final URL.
 */
export function createResolve(fetchFn: (url: string) => CacheEntry): ResolveHookSync;
export function createResolve(fetchFn: (url: string) => Promise<CacheEntry>): ResolveHookAsync;
export function createResolve(fetchFn: (url: string) => CacheEntry | Promise<CacheEntry>) {
  return function resolve(specifier: string, context: ResolveHookContext, nextResolve: NextResolve): ResolveFnOutput | Promise<ResolveFnOutput> {
    // Direct URLs, relative imports, CDN packages and the CLI entry share this path.
    const resolveHttp = (url: string): ResolveFnOutput | Promise<ResolveFnOutput> => {
      const handleFetched = (entry: CacheEntry): ResolveFnOutput => {
        const format = inferFormat(entry.finalUrl, entry.contentType);
        if (tmpEnabled) {
          const temporaryPath = urlToTmpPath(entry.finalUrl, entry.contentType);
          writeTmpFile(temporaryPath, entry.source);
          return { shortCircuit: true, url: pathToFileURL(temporaryPath).href, format };
        }
        pendingLoads.set(entry.finalUrl, entry);
        return { shortCircuit: true, url: entry.finalUrl, format };
      };
      const entry = fetchFn(url);
      return entry instanceof Promise ? entry.then(handleFetched) : handleFetched(entry);
    };

    // Node resolves the placeholder entry without a parentURL.
    if (mainUrl && !context.parentURL && !isHttpUrl(specifier)) return resolveHttp(mainUrl);

    // Installed npm: packages stay local; only MODULE_NOT_FOUND triggers a CDN fallback.
    if (specifier.startsWith("npm:")) {
      const bare = stripNpmSpecifier(specifier);
      try {
        return resolveLocalPackage(bare, context, nextResolve);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")) throw error;
        return resolveHttp((cdnBase ?? DEFAULT_CDN) + specifier.slice(4));
      }
    }

    // esm.sh is the only supported CDN with a /jsr/ endpoint.
    if (specifier.startsWith("jsr:")) {
      if (cdnBase && isEsmShCdn(cdnBase)) return resolveHttp(jsrToCdnUrl(specifier, cdnBase));
      throw new Error(`Cannot resolve "${specifier}": jsr: specifiers require --cdn=https://esm.sh/.`);
    }
    if (isHttpUrl(specifier)) return resolveHttp(specifier);
    if (cdnBase && isBareSpecifier(specifier) && !isBuiltin(specifier)) return resolveHttp(cdnBase + specifier);

    const httpParent = getHttpParentUrl(context.parentURL);
    if (httpParent && isRelativeSpecifier(specifier)) return resolveHttp(new URL(specifier, httpParent).href);
    // Native package resolution cannot use an HTTP parent. Keep its import/
    // require conditions but anchor it to the local project's node_modules.
    if (httpParent) return nextResolve(specifier, { ...context, parentURL: projectParentUrl() });
    return nextResolve(specifier, context);
  };
}

/** Create a load hook that supplies verified remote source bytes and their format. */
export function createLoad(fetchFn: (url: string) => CacheEntry): LoadHookSync;
export function createLoad(fetchFn: (url: string) => Promise<CacheEntry>): LoadHookAsync;
export function createLoad(fetchFn: (url: string) => CacheEntry | Promise<CacheEntry>) {
  return function load(url: string, context: LoadHookContext, nextLoad: NextLoad): LoadFnOutput | Promise<LoadFnOutput> {
    if (!isHttpUrl(url)) return nextLoad(url, context);
    const cached = pendingLoads.get(url);
    pendingLoads.delete(url);
    const handleFetched = (entry: CacheEntry): LoadFnOutput => {
      verifyModuleLock(entry);
      return { shortCircuit: true, format: inferFormat(entry.finalUrl, entry.contentType), source: entry.source };
    };
    const entry = cached ?? fetchFn(url);
    return entry instanceof Promise ? entry.then(handleFetched) : handleFetched(entry);
  };
}

// Ready-made synchronous hooks for module.registerHooks().
export const resolve = createResolve(fetchModuleSync);
export const load = createLoad(fetchModuleSync);
