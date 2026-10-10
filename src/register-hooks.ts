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
let mainUrl = process.env.URL_IMPORT_MAIN;
const mainCandidates = process.env.URL_IMPORT_MAIN_CANDIDATES;
// Internal entry metadata must not be inherited by later Workers or children.
delete process.env.URL_IMPORT_MAIN;
delete process.env.URL_IMPORT_MAIN_CANDIDATES;
if (mainCandidates) {
  const candidates: Record<string, string> = JSON.parse(mainCandidates);
  const index = process.execArgv.length - 2;
  const target = candidates[candidates[index] === "--" ? index + 1 : index];
  if (target && isHttpUrl(target) && resolvePath(target) === process.argv[1]) {
    mainUrl = target;
  }
}

export const importMetaUrl = import.meta.url;

if (typeof module.registerHooks === "function") {
  // Node 22.15+: synchronous hooks that intercept both import and require
  const { createResolve, load } = await import("./hooks.ts");
  const { fetchModuleSync } = await import("./sync-fetch.ts");
  module.registerHooks({ resolve: createResolve(fetchModuleSync, mainUrl), load });
} else {
  // Node 18.19+ / 20.6+: async hooks via module.register() (ESM only)
  const loaderUrl = new URL(import.meta.url.endsWith(".ts") ? "./loader.ts" : "./loader.js", import.meta.url);
  module.register(loaderUrl, import.meta.url, { data: { mainUrl } });
}
