/**
 * Node.js ESM Loader Hooks for HTTP(S) URL imports.
 *
 * Usage:
 *   node --loader node-url-import/loader ./app.mjs
 *   node --import node-url-import/register ./app.mjs
 */

import { pathToFileURL } from "node:url";
import { fetchModule } from "./fetch.ts";
import { cachePaths } from "./cache.ts";
import { isHttpUrl } from "./constants.ts";

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

export type NextLoad = (url: string, context: LoadContext) => Promise<LoadResult>;

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

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  // npm: specifier — strip the prefix and let Node resolve from node_modules.
  if (specifier.startsWith("npm:")) {
    return nextResolve(specifier.slice(4), context);
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
