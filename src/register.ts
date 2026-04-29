/**
 * Registration entry-point for the modern --import flag:
 *
 *   node --import node-url-import/register ./app.mjs
 *
 * Calls `module.register()` (stable in Node 20.6+, back-ported to 18.19+)
 * to install the loader hooks in a dedicated loader thread.
 */

import { register } from "node:module";
import { importMetaURL } from "./loader.ts";

register(importMetaURL, import.meta.url);
