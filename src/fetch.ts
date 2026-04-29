import { readCache, writeCache } from "./cache.ts";
import type { CacheEntry } from "./cache.ts";
import { NAME, MAX_REDIRECTS } from "./constants.ts";
import { verifyLock, isLockEnabled } from "./lock.ts";
import {
  downloadStart,
  downloadAdd,
  downloadBegin,
  downloadDone,
} from "./progress.ts";

let sessionStarted = false;

const reload: boolean = process.env.URL_IMPORT_RELOAD === "1";

export async function fetchModule(url: string): Promise<CacheEntry> {
  const cached = reload ? null : await readCache(url);

  if (cached) {
    if (isLockEnabled()) await verifyLock(url, cached.source);
    return cached;
  }

  if (!sessionStarted) {
    sessionStarted = true;
    downloadStart();
  }

  downloadAdd();
  downloadBegin(url);

  let currentUrl = url;

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

    await writeCache(url, source, contentType, currentUrl);

    if (isLockEnabled()) await verifyLock(url, source);

    downloadDone();

    return { source, contentType, url, finalUrl: currentUrl };
  }

  throw new Error(`Too many redirects fetching ${url}`);
}
