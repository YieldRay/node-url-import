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

module.registerHooks({ resolve, load });
