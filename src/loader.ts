/**
 * Async ESM loader hooks for module.register() (Node 18.19+ / 20.6+).
 *
 * Uses the async fetchModule() directly (no worker-in-worker overhead).
 * module.register() runs these hooks in a dedicated loader thread where
 * async operations are natural.
 *
 * Only supports ESM import (not CJS require).
 */

import { createResolve, createLoad } from "./hooks.ts";
import { fetchModule } from "./fetch.ts";

export const importMetaUrl = import.meta.url;

export const resolve = createResolve(fetchModule);
export const load = createLoad(fetchModule);
