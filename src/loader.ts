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

let resolveHook = createResolve(fetchModule);
export const load = createLoad(fetchModule);

export function initialize(data: { mainUrl?: string } = {}): void {
  resolveHook = createResolve(fetchModule, data.mainUrl);
}

// Node captures exported hook functions before initialize() runs. Keep that
// function identity stable while initialization configures its delegate.
export function resolve(...args: Parameters<typeof resolveHook>) {
  return resolveHook(...args);
}
