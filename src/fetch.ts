import process from "node:process";
import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { decodeModuleSource, readCache, writeCache } from "./cache.ts";
import type { CacheEntry } from "./cache.ts";
import { getFetchTimeoutMs, NAME, MAX_REDIRECTS, isHttpUrl } from "./constants.ts";
import { resolveLockRedirects, verifyModuleLock } from "./lock.ts";
import { downloadAdd, downloadBegin, downloadDone } from "./progress.ts";

const reload: boolean = process.env.URL_IMPORT_RELOAD === "1";
const authTokens = parseAuthTokens(process.env.DENO_AUTH_TOKENS);

interface AuthToken {
  host: string;
  matchSubdomains: boolean;
  authorization: string;
}

/** Deno 2.9.8 trims the whole list and splits credentials at the last @. */
function parseAuthTokens(value: string | undefined): AuthToken[] {
  if (value === undefined) return [];
  const tokens: AuthToken[] = [];
  for (const entry of value.trim().split(";")) {
    const separator = entry.lastIndexOf("@");
    if (separator === -1) {
      console.error("Badly formed auth token discarded.");
      continue;
    }
    const credentials = entry.slice(0, separator);
    const host = entry.slice(separator + 1).toLowerCase();
    const ipv6 = host.match(/^\[([^\]]+)\](?::(\d+))?$/);
    const ipv4 = host.match(/^([^:]+)(?::(\d+))?$/);
    const address = ipv6?.[1] ?? ipv4?.[1];
    const port = ipv6?.[2] ?? ipv4?.[2];
    // IP addresses match exactly, including equivalent IPv6 spellings. Domain
    // suffixes retain their spelling and port; default URL ports are absent.
    const ip = address !== undefined && !address.includes("%") && isIP(address) === (ipv6 ? 6 : 4) &&
      (port === undefined || Number(port) <= 65535);
    const authority = ip
      ? new URL(`http://${ipv6 ? `[${address}]` : address}`).hostname + (port === undefined ? "" : `:${Number(port)}`)
      : host.replace(/^\./, "");
    tokens.push({
      host: authority,
      matchSubdomains: !ip,
      authorization: credentials.includes(":") ? `Basic ${Buffer.from(credentials).toString("base64")}` : `Bearer ${credentials}`,
    });
  }
  return tokens;
}

function authorizationForUrl(url: string): string | undefined {
  const host = new URL(url).host;
  return authTokens.find((token) => token.host === host ||
    (token.matchSubdomains && host.endsWith(`.${token.host}`)))?.authorization;
}

function stripRedirectCredentials(headers: Headers, fromUrl: string, toUrl: string): void {
  if (new URL(fromUrl).origin === new URL(toUrl).origin) return;
  for (const name of ["Authorization", "Proxy-Authorization", "Cookie", "Cookie2"]) {
    headers.delete(name);
  }
}

export interface FetchOptions {
  /** Timeout for requests and response bodies, including sync worker startup; defaults to 60_000 ms. */
  timeoutMs?: number;
  /** Request headers override defaults and auth tokens; redirecting across origins removes credentials. */
  headers?: HeadersInit;
}

/**
 * Fetch a remote module by URL, returning its source and content type.
 *
 * Results are cached in Deno's remote module cache (`$DENO_DIR/remote/`) and
 * reused on subsequent calls. Pass `URL_IMPORT_RELOAD=1` to bypass the cache.
 *
 * @param url - The `http://` or `https://` URL to fetch.
 * @returns The module source, content type, original URL, and final URL after redirects.
 * @throws If the request fails, times out or exceeds the redirect limit.
 */
export async function fetchModule(url: string, options: FetchOptions = {}): Promise<CacheEntry> {
  const signal = AbortSignal.timeout(getFetchTimeoutMs(options.timeoutMs));
  const requestHeaders = new Headers(options.headers);
  if (!requestHeaders.has("User-Agent")) requestHeaders.set("User-Agent", NAME);
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
    // Locked redirects skip HTTP requests, but must still strip caller credentials.
    for (let hop = 1; hop < lockedChain.length; hop++) {
      stripRedirectCredentials(requestHeaders, lockedChain[hop - 1], lockedChain[hop]);
    }

    // The terminal response needs one request after up to MAX_REDIRECTS hops.
    for (let redirects = lockedChain.length - 1; redirects <= MAX_REDIRECTS; redirects++) {
      const headers = new Headers(requestHeaders);
      // Select credentials for this hop, never forward the previous host's token.
      const authorization = headers.has("Authorization") ? undefined : authorizationForUrl(currentUrl);
      if (authorization !== undefined) {
        try {
          if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(authorization)) throw new TypeError();
          headers.set("Authorization", authorization);
        } catch {
          // Header validation errors can include the value; keep tokens private.
          throw new TypeError("Invalid Authorization header in DENO_AUTH_TOKENS");
        }
      }
      const res = await fetch(currentUrl, {
        headers,
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
        stripRedirectCredentials(requestHeaders, currentUrl, nextUrl.href);
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
