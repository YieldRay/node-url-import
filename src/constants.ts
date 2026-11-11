export const NAME = "node-url-import";
export const MAX_REDIRECTS = 10;
export const DEFAULT_CDN = "https://esm.sh/";
export const FETCH_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export function getFetchTimeoutMs(timeoutMs = FETCH_TIMEOUT_MS): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`The fetch timeout must be a positive integer no greater than ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
