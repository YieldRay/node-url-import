import process from "node:process";
import { decodeModuleSource, readCache, writeCache } from "./cache.ts";
import type { CacheEntry } from "./cache.ts";
import { FETCH_TIMEOUT_MS, NAME, MAX_REDIRECTS, isHttpUrl } from "./constants.ts";
import { resolveLockRedirects, verifyModuleLock } from "./lock.ts";
import { downloadAdd, downloadBegin, downloadDone } from "./progress.ts";

const reload: boolean = process.env.URL_IMPORT_RELOAD === "1";

export interface FetchOptions {
  /** Cancels network requests and response-body reads, including redirect hops. */
  signal?: AbortSignal;
}

/**
 * Fetch a remote module by URL, returning its source and content type.
 *
 * Results are cached in Deno's remote module cache (`$DENO_DIR/remote/`) and
 * reused on subsequent calls. Pass `URL_IMPORT_RELOAD=1` to bypass the cache.
 *
 * @param url - The `http://` or `https://` URL to fetch.
 * @returns The module source, content type, original URL, and final URL after redirects.
 * @throws If the request fails, is cancelled or exceeds the redirect limit.
 */
export async function fetchModule(url: string, options: FetchOptions = {}): Promise<CacheEntry> {
  const signal = options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS);
  signal.throwIfAborted();
  const normalizedUrl = new URL(url).href;
  if (!isHttpUrl(normalizedUrl)) throw new TypeError(`Expected an HTTP(S) module URL: ${url}`);
  const lockedChain = resolveLockRedirects(normalizedUrl);
  const cached = reload ? null : readCache(lockedChain.at(-1)!);

  if (cached) {
    const entry = { ...cached, url: normalizedUrl, redirectChain: [...lockedChain.slice(0, -1), ...cached.redirectChain] };
    if (entry.redirectChain.length > MAX_REDIRECTS + 1) throw new Error(`Too many redirects fetching ${url}`);
    verifyModuleLock(entry);
    return entry;
  }

  downloadAdd();
  downloadBegin(url);

  // Mark the slot done even on error, so counters stay balanced and the
  // progress bar can clear (a failed fetch must not orphan a slot).
  try {
    let currentUrl = lockedChain.at(-1)!;
    const redirectChain = [...lockedChain];
    const redirectLocations: string[] = [];

    // The terminal response needs one request after up to MAX_REDIRECTS hops.
    for (let redirects = lockedChain.length - 1; redirects <= MAX_REDIRECTS; redirects++) {
      const res = await fetch(currentUrl, {
        headers: { "User-Agent": NAME },
        redirect: "manual",
        signal,
      });

      if (res.status >= 300 && res.status < 400) {
        // Drain the response body to free the connection
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (!location) {
          throw new Error(`Redirect from ${currentUrl} had no Location header`);
        }
        if (redirects === MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url}`);
        const nextUrl = new URL(location, currentUrl);
        // Match Deno's URL join: a Location without # drops the request fragment.
        if (!isHttpUrl(nextUrl.href)) throw new TypeError(`Unsupported redirect URL: ${nextUrl.href}`);
        currentUrl = nextUrl.href;
        redirectChain.push(currentUrl);
        redirectLocations.push(location);
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(
          `Failed to fetch ${currentUrl}: ${res.status} ${res.statusText}`,
        );
      }

      const contentType = res.headers.get("content-type") || "application/javascript";
      const bytes = new Uint8Array(await res.arrayBuffer());
      const source = decodeModuleSource(bytes, currentUrl, contentType);

      signal.throwIfAborted();
      const entry = { source, contentType, url: normalizedUrl, finalUrl: currentUrl, redirectChain };
      verifyModuleLock(entry);
      // Locked hops are not HTTP responses; only publish the downloaded chain.
      writeCache(redirectChain.slice(lockedChain.length - 1), bytes, contentType, redirectLocations);
      return entry;
    }

    throw new Error(`Too many redirects fetching ${url}`);
  } finally {
    downloadDone();
  }
}
