export const NAME = "node-url-import";
export const MAX_REDIRECTS = 10;
export const DEFAULT_CDN = "https://esm.sh/";
export const FETCH_TIMEOUT_MS = 60_000;

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
