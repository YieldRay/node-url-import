/**
 * --tmp mode: write fetched remote modules to a human-readable tmp directory
 * structure that mirrors the URL, so modules see themselves as local files.
 *
 * Example:
 *   https://esm.sh/v135/pkg@1.0.0/script.js
 *   → /tmp/node-url-import/https/esm.sh/v135/pkg@1.0.0/script.js
 *
 * URLs without a recognised file extension (e.g. https://esm.sh/ms@2.1.3)
 * get an `index.<ext>` appended so they become directories, avoiding
 * collisions with child paths (e.g. .../ms@2.1.3/es2022/ms.mjs).
 *
 * This is CLI-only. The loader never enables this on its own — it is
 * activated via the URL_IMPORT_TMP=1 environment variable set by the CLI.
 */

import process from "node:process";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NAME } from "./constants.ts";

/** Root directory for tmp files: <system-tmp>/node-url-import/ */
const TMP_ROOT = join(tmpdir(), NAME);

/** Whether --tmp mode is active. */
export const tmpEnabled: boolean = process.env.URL_IMPORT_TMP === "1";

/** File extensions recognised as "has an extension" — no index.<ext> needed. */
const KNOWN_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".jsx",
  ".json",
  ".wasm",
]);

/** Map content-type to a file extension for extensionless URLs. */
function extForContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/typescript") || ct.includes("application/typescript"))
    return ".ts";
  if (ct.includes("application/json")) return ".json";
  if (ct.includes("application/wasm")) return ".wasm";
  // Default to .mjs for JS/unknown — .mjs is unambiguous ESM for Node.
  return ".mjs";
}

/**
 * Convert an HTTP(S) URL to a local tmp file path.
 *
 * If the URL pathname has no recognised file extension, an `index.<ext>`
 * suffix is appended based on the content type so the path can coexist
 * as a directory with child modules.
 *
 * https://esm.sh/v135/pkg@1.0.0/script.js
 * → <TMP_ROOT>/https/esm.sh/v135/pkg@1.0.0/script.js
 *
 * https://esm.sh/ms@2.1.3  (content-type: application/javascript)
 * → <TMP_ROOT>/https/esm.sh/ms@2.1.3/index.mjs
 */
export function urlToTmpPath(url: string, contentType?: string): string {
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(/:$/, ""); // "https" or "http"
  let pathname = parsed.pathname;

  const ext = extname(pathname);
  if (!KNOWN_EXTS.has(ext)) {
    // No recognised extension — treat as directory, add index file.
    const inferredExt = extForContentType(contentType ?? "");
    pathname = pathname.replace(/\/$/, "") + "/index" + inferredExt;
  }

  return join(TMP_ROOT, scheme, parsed.host, pathname);
}

/**
 * Reverse-map a file:// URL (or local path) under the tmp root back to its
 * original HTTP(S) URL. Returns null if the path is not under TMP_ROOT.
 *
 * For paths that end with /index.<ext> (written by urlToTmpPath for
 * extensionless URLs), the index file is stripped so the original URL
 * is recovered.
 *
 * file:///tmp/node-url-import/https/esm.sh/v135/pkg@1.0.0/script.js
 * → https://esm.sh/v135/pkg@1.0.0/script.js
 *
 * file:///tmp/node-url-import/https/esm.sh/ms@2.1.3/index.mjs
 * → https://esm.sh/ms@2.1.3
 */
export function tmpPathToUrl(fileUrl: string): string | null {
  let filePath: string;
  try {
    filePath = fileUrl.startsWith("file://")
      ? fileURLToPath(fileUrl)
      : fileUrl;
  } catch {
    return null;
  }

  if (!filePath.startsWith(TMP_ROOT)) return null;

  // Strip the TMP_ROOT prefix to get: <scheme>/<host>/<path...>
  const relative = filePath.slice(TMP_ROOT.length + 1); // +1 for the trailing /
  const slashIdx = relative.indexOf("/");
  if (slashIdx === -1) return null;

  const scheme = relative.slice(0, slashIdx);
  let rest = relative.slice(slashIdx + 1);

  // Strip /index.<ext> suffix that was added for extensionless URLs.
  const indexMatch = rest.match(/\/index\.(mjs|js|ts|json|wasm)$/);
  if (indexMatch) {
    rest = rest.slice(0, -indexMatch[0].length);
  }

  // rest is: <host>/<pathname...>
  return `${scheme}://${rest}`;
}

/**
 * Write module source to a tmp path, creating parent directories as needed.
 */
export async function writeTmpFile(
  tmpPath: string,
  source: string,
): Promise<void> {
  await mkdir(dirname(tmpPath), { recursive: true });
  await writeFile(tmpPath, source, "utf-8");
}
