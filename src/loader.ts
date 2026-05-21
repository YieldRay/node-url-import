/**
 * ESM loader hooks file for module.register() (Node 18.19+ / 20.6+).
 *
 * module.register() loads this file in a separate worker thread.
 * The sync resolve/load functions from hooks.ts work directly here —
 * when they call nextResolve/nextLoad (which return Promises in the
 * async hook context), the returned Promise is automatically awaited
 * by Node's loader machinery since async hooks accept Promise returns.
 *
 * Only supports ESM import (not CJS require).
 */

export { resolve, load } from "./hooks.ts";

export const importMetaUrl = import.meta.url;
