/**
 * Registration entry-point using module.registerHooks() (Node 22.15+).
 * Intercepts both import() and require() calls for HTTP(S) URLs.
 *
 * Usage:
 *   node --import node-url-import/register ./app.mjs
 *   node --import node-url-import/register ./app.cjs
 */

import module from "node:module";
import { resolve, load } from "./hooks.ts";

export const importMetaUrl = import.meta.url;

// Cast needed because @types/node's ModuleSource is broader than our return type
module.registerHooks({
  resolve: resolve as Parameters<typeof module.registerHooks>[0]["resolve"],
  load: load as Parameters<typeof module.registerHooks>[0]["load"],
});
