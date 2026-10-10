import process from "node:process";
import { decodeModuleSource, readCache, writeCache } from "./cache.ts";
import type { CacheEntry } from "./cache.ts";
import { NAME, MAX_REDIRECTS } from "./constants.ts";
import { verifyModuleLock } from "./lock.ts";
import { downloadAdd, downloadBegin, downloadDone } from "./progress.ts";

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
    verifyModuleLock(cached);
    return cached;
  }

  downloadAdd();
  downloadBegin(url);

  // Mark the slot done even on error, so counters stay balanced and the
  // progress bar can clear (a failed fetch must not orphan a slot).
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

      const contentType = res.headers.get("content-type") || "application/javascript";
      const source = decodeModuleSource(new Uint8Array(await res.arrayBuffer()), currentUrl, contentType);

      const entry = { source, contentType, url, finalUrl: currentUrl, redirectChain };
      verifyModuleLock(entry);
      writeCache(redirectChain, source, contentType);
      return entry;
    }

    throw new Error(`Too many redirects fetching ${url}`);
  } finally {
    downloadDone();
  }
}
