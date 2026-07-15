import process from "node:process";
import { readCache, writeCache } from "./cache.ts";
import type { CacheEntry } from "./cache.ts";
import { NAME, MAX_REDIRECTS } from "./constants.ts";
import { verifyLock, recordRedirect, isLockEnabled } from "./lock.ts";
import {
  downloadStart,
  downloadAdd,
  downloadBegin,
  downloadDone,
} from "./progress.ts";

let sessionStarted = false;

const reload: boolean = process.env.URL_IMPORT_RELOAD === "1";

/**
 * Fetch a remote module by URL, returning its source and content type.
 *
 * Results are cached in Deno's remote module cache (`$DENO_DIR/remote/`) and
 * reused on subsequent calls. Pass `URL_IMPORT_RELOAD=1` to bypass the cache.
 *
 * @param url - The `http://` or `https://` URL to fetch.
 * @returns The module source, content type, original URL, and final URL after redirects.
 * @throws If the request fails or exceeds the redirect limit.
 */
export async function fetchModule(url: string): Promise<CacheEntry> {
  const cached = reload ? null : readCache(url);

  if (cached) {
    if (isLockEnabled()) {
      recordRedirect(url, cached.finalUrl);
      verifyLock(cached.finalUrl, cached.source);
    }
    return cached;
  }

  if (!sessionStarted) {
    sessionStarted = true;
    downloadStart();
  }

  downloadAdd();
  downloadBegin(url);

  // Always mark this download slot as finished, even on error, so the progress
  // bar's done/total counters stay balanced and downloadEnd() can fire. Without
  // this, a failed fetch leaves an orphaned slot that prevents the bar from ever
  // clearing (and leaves a stale line on the terminal).
  try {
    let currentUrl = url;
    const redirectChain: string[] = [url];

    for (let i = 0; i < MAX_REDIRECTS; i++) {
      const res = await fetch(currentUrl, {
        headers: { "User-Agent": NAME },
        redirect: "manual",
      });

      if (res.status >= 300 && res.status < 400) {
        // Drain the response body to free the connection
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (!location) {
          throw new Error(`Redirect from ${currentUrl} had no Location header`);
        }
        currentUrl = new URL(location, currentUrl).href;
        redirectChain.push(currentUrl);
        continue;
      }

      if (!res.ok) {
        throw new Error(
          `Failed to fetch ${currentUrl}: ${res.status} ${res.statusText}`,
        );
      }

      const source: string = await res.text();
      const contentType: string =
        res.headers.get("content-type") || "application/javascript";

      writeCache(redirectChain, source, contentType);

      if (isLockEnabled()) {
        recordRedirect(url, currentUrl);
        verifyLock(currentUrl, source);
      }

      return { source, contentType, url, finalUrl: currentUrl };
    }

    throw new Error(`Too many redirects fetching ${url}`);
  } finally {
    downloadDone();
  }
}
