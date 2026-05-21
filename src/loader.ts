/**
 * Async ESM loader hooks for module.register() (Node 18.19+ / 20.6+).
 *
 * Thin async wrappers that delegate to the sync resolve/load in hooks.ts.
 * The sync hooks call nextResolve/nextLoad at the end for non-HTTP specifiers,
 * so we wrap the async next* callbacks to make them synchronous-looking by
 * blocking. However, since module.register() hooks run in a worker thread
 * where the event loop is available, we can simply make the outer function
 * async and await the result of the sync hook if it happens to return a
 * Promise (which it won't for HTTP URLs — only for the fallthrough case).
 *
 * Only supports ESM import (not CJS require).
 */

import { resolve as syncResolve, load as syncLoad } from "./hooks.ts";
import type { ResolveHookContext, ResolveFnOutput, LoadHookContext, LoadFnOutput } from "node:module";

export const importMetaUrl = import.meta.url;

type AsyncNextResolve = (specifier: string, context?: Partial<ResolveHookContext>) => Promise<ResolveFnOutput>;
type AsyncNextLoad = (url: string, context?: Partial<LoadHookContext>) => Promise<LoadFnOutput>;

export async function resolve(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: AsyncNextResolve,
): Promise<ResolveFnOutput> {
  // Wrap the async nextResolve to be callable from our sync hook.
  // For HTTP URLs, our hook short-circuits and never calls next.
  // For non-HTTP specifiers, we need to await the result.
  let pendingNext: Promise<ResolveFnOutput> | null = null;

  const syncNext = (spec: string, ctx?: Partial<ResolveHookContext>) => {
    pendingNext = nextResolve(spec, ctx);
    // Return a placeholder — we'll await pendingNext below
    return { url: spec } as ResolveFnOutput;
  };

  const result = syncResolve(specifier, context, syncNext);

  // If the sync hook fell through to nextResolve, await the pending promise
  if (pendingNext) {
    return pendingNext;
  }

  return result;
}

export async function load(
  url: string,
  context: LoadHookContext,
  nextLoad: AsyncNextLoad,
): Promise<LoadFnOutput> {
  let pendingNext: Promise<LoadFnOutput> | null = null;

  const syncNext = (u: string, ctx?: Partial<LoadHookContext>) => {
    pendingNext = nextLoad(u, ctx);
    return { format: null, source: undefined } as unknown as LoadFnOutput;
  };

  const result = syncLoad(url, context, syncNext);

  if (pendingNext) {
    return pendingNext;
  }

  return result;
}
