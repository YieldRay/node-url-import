/**
 * Registration entry-point for the --import flag.
 *
 * Uses module.registerHooks() on Node 22.15+ (supports both import and require).
 * Falls back to module.register() on Node 18.19+ / 20.6+ (ESM import only).
 *
 * Usage:
 *   node --import node-url-import/register ./app.mjs
 *   node --import node-url-import/register ./app.cjs   # Node 24+ only
 */

import module from "node:module";

export const importMetaUrl = import.meta.url;

if (typeof module.registerHooks === "function") {
  // Node 22.15+: synchronous hooks that intercept both import and require
  const { resolve, load } = await import("./hooks.ts");
  module.registerHooks({ resolve, load });
} else {
  // Node 18.19+ / 20.6+: async hooks via module.register() (ESM only)
  const { importMetaUrl: loaderUrl } = await import("./loader.ts");
  module.register(loaderUrl, import.meta.url);
}
