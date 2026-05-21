/**
 * Smart registration entry-point that uses module.registerHooks() on Node 22.15+
 * (supports both import and require of HTTP URLs), falling back to module.register()
 * on older Node versions (ESM import only, no require support).
 *
 * Usage:
 *   node --import node-url-import/register ./app.mjs       # ESM (all supported Node)
 *   node --import node-url-import/register ./app.cjs       # CJS require of URLs (Node 22.15+)
 */

import module from "node:module";
import { resolve, load } from "./hooks.ts";

export const importMetaUrl = import.meta.url;

if (typeof module.registerHooks === "function") {
  // Node 22.15+ / 23.5+: synchronous hooks that intercept both import and require
  // Cast needed because @types/node's ModuleSource is broader than our return type
  module.registerHooks({
    resolve: resolve as Parameters<typeof module.registerHooks>[0]["resolve"],
    load: load as Parameters<typeof module.registerHooks>[0]["load"],
  });
} else {
  // Fallback: async hooks via module.register() (ESM only)
  const { importMetaUrl: loaderImportMetaUrl } = await import("./loader.ts");
  module.register(loaderImportMetaUrl, import.meta.url);
}
