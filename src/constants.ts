export const NAME = "node-url-import";
export const MAX_REDIRECTS = 10;

export function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
