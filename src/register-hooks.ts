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
import process from "node:process";
import { resolve as resolvePath } from "node:path";
import { isHttpUrl } from "./constants.ts";

// Node has already parsed its flags. Exclude the CLI's injected --import pair
// when locating the original entry; eval arguments must not become remote mains.
const mainCandidates = process.env.URL_IMPORT_MAIN_CANDIDATES;
delete process.env.URL_IMPORT_MAIN_CANDIDATES;
if (mainCandidates) {
  const candidates: Record<string, string> = JSON.parse(mainCandidates);
  const index = process.execArgv.length - 2;
  const target = candidates[candidates[index] === "--" ? index + 1 : index];
  if (target && isHttpUrl(target) && resolvePath(target) === process.argv[1]) {
    process.env.URL_IMPORT_MAIN = target;
  }
}

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
