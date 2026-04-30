/**
 * Node.js ESM Loader Hooks for HTTP(S) URL imports.
 *
 * Usage:
 *   node --loader node-url-import/loader ./app.mjs
 *   node --import node-url-import/register ./app.mjs
 */

import process from "node:process";
import { pathToFileURL } from "node:url";
import { fetchModule } from "./fetch.ts";
import { cachePaths } from "./cache.ts";
import { isHttpUrl } from "./constants.ts";

export const importMetaUrl = import.meta.url;
const patchMeta: boolean = process.env.URL_IMPORT_LOCAL_META === "1";

type ModuleFormat = "module" | "commonjs" | "json" | "wasm";

interface ResolveContext {
  conditions?: string[];
  importAttributes?: Record<string, string>;
  parentURL?: string;
}

interface ResolveResult {
  shortCircuit?: boolean;
  url: string;
  format?: ModuleFormat;
}

interface LoadContext {
  conditions?: string[];
  format?: ModuleFormat;
  importAttributes?: Record<string, string>;
}

interface LoadResult {
  shortCircuit?: boolean;
  format: ModuleFormat;
  source: string;
}

export type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => Promise<ResolveResult>;

export type NextLoad = (
  url: string,
  context: LoadContext,
) => Promise<LoadResult>;

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

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  // npm: specifier — strip the prefix and version, let Node resolve from node_modules.
  //   npm:ms@2.1.3         → ms
  //   npm:@scope/pkg@1.0.0 → @scope/pkg
  //   npm:@scope/pkg@1.0.0/sub → @scope/pkg/sub
  if (specifier.startsWith("npm:")) {
    return nextResolve(stripNpmSpecifier(specifier), context);
  }

  // Direct HTTP(S) URL
  if (isHttpUrl(specifier)) {
    return { shortCircuit: true, url: specifier };
  }

  // Relative or absolute URL import inside an HTTP-loaded module.
  // Bare specifiers like "fs", "node:fs" fall through to Node's default resolver.
  if (
    context.parentURL &&
    isHttpUrl(context.parentURL) &&
    (specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier.startsWith("/"))
  ) {
    const resolved = new URL(specifier, context.parentURL).href;
    return { shortCircuit: true, url: resolved };
  }

  return nextResolve(specifier, context);
}

export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad,
): Promise<LoadResult> {
  if (isHttpUrl(url)) {
    let { source, contentType } = await fetchModule(url);
    const format = inferFormat(url, contentType);

    if (patchMeta && format === "module") {
      const { file } = cachePaths(url);
      const fileUrl = pathToFileURL(file).href;
      source = `import.meta.url = ${JSON.stringify(fileUrl)};\n` + source;
    }

    return { shortCircuit: true, format, source };
  }

  return nextLoad(url, context);
}
