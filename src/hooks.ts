/**
 * Synchronous resolve + load hooks for module.registerHooks().
 *
 * These hooks intercept both import() and require() calls for HTTP(S) URLs.
 * They use fetchModuleSync() which blocks via Atomics.wait on cache miss.
 *
 * Requires Node.js 22.15+ or 23.5+.
 */

import { pathToFileURL } from "node:url";
import { fetchModuleSync } from "./sync-fetch.ts";
import { isHttpUrl } from "./constants.ts";
import { tmpEnabled, urlToTmpPath, writeTmpFile, tmpPathToUrl } from "./tmp.ts";

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

type ModuleFormat = "module" | "commonjs" | "json" | "wasm";

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

// Use Node's own hook types for compatibility
interface ResolveHookContext {
  conditions?: string[];
  importAttributes?: Record<string, string | undefined>;
  parentURL?: string;
}

interface ResolveFnOutput {
  format?: string | null | undefined;
  importAttributes?: Record<string, string | undefined>;
  shortCircuit?: boolean | undefined;
  url: string;
}

interface LoadHookContext {
  conditions?: string[];
  format?: string | null | undefined;
  importAttributes?: Record<string, string | undefined>;
}

interface LoadFnOutput {
  format?: string | null | undefined;
  shortCircuit?: boolean | undefined;
  source?: string | ArrayBuffer | SharedArrayBuffer | Uint8Array | undefined;
}

type NextResolve = (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput;
type NextLoad = (url: string, context?: Partial<LoadHookContext>) => LoadFnOutput;

function inferFormat(url: string, contentType: string): ModuleFormat {
  const ct = contentType.toLowerCase();

  if (ct.includes("application/json")) return "json";
  if (ct.includes("application/wasm")) return "wasm";
  if (ct.includes("text/typescript") || ct.includes("application/typescript"))
    return "module";

  const pathname = new URL(url).pathname;
  if (pathname.endsWith(".json")) return "json";
  if (pathname.endsWith(".wasm")) return "wasm";
  if (pathname.endsWith(".cjs")) return "commonjs";
  if (pathname.endsWith(".mjs")) return "module";

  return "module";
}

export function resolve(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: NextResolve,
): ResolveFnOutput {
  // npm: specifier — strip prefix and version, let Node resolve from node_modules.
  if (specifier.startsWith("npm:")) {
    return nextResolve(stripNpmSpecifier(specifier), context);
  }

  // Direct HTTP(S) URL
  if (isHttpUrl(specifier)) {
    const { finalUrl, source, contentType } = fetchModuleSync(specifier);

    if (tmpEnabled) {
      const tmpPath = urlToTmpPath(finalUrl, contentType);
      writeTmpFile(tmpPath, source);
      const format = inferFormat(finalUrl, contentType);
      return { shortCircuit: true, url: pathToFileURL(tmpPath).href, format };
    }

    return { shortCircuit: true, url: finalUrl };
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
      const { finalUrl, source, contentType } = fetchModuleSync(resolved);
      const tmpPath = urlToTmpPath(finalUrl, contentType);
      writeTmpFile(tmpPath, source);
      const format = inferFormat(finalUrl, contentType);
      return { shortCircuit: true, url: pathToFileURL(tmpPath).href, format };
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
}

export function load(
  url: string,
  context: LoadHookContext,
  nextLoad: NextLoad,
): LoadFnOutput {
  if (isHttpUrl(url)) {
    const { source, contentType } = fetchModuleSync(url);
    const format = inferFormat(url, contentType);
    return { shortCircuit: true, format, source };
  }

  return nextLoad(url, context);
}
