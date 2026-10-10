/**
 * --tmp mode: write remote modules beneath a readable, per-process directory.
 *
 *   https://esm.sh/pkg/mod.ts
 *   → <tmp>/node-url-import/session-.../https/esm.sh/pkg/mod.ts/module-<id>.ts
 *
 * Each URL, including query and fragment, gets its own module file. The reverse
 * map retains the exact URL rather than reconstructing it from a synthetic file
 * name, so extensionless URLs keep their original relative-import base.
 * Activated by URL_IMPORT_TMP=1, normally set by the CLI's --tmp option.
 */

import process from "node:process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, dirname, extname, resolve } from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NAME } from "./constants.ts";
import { writeFileAtomicSync } from "./cache.ts";
import type { ModuleSource } from "./cache.ts";

/** Whether readable temporary module files are enabled. */
export const tmpEnabled = process.env.URL_IMPORT_TMP === "1";
const sourceUrls = new Map<string, string>();
const KNOWN_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".json", ".wasm"]);
let temporaryRoot: string | undefined;

function getTemporaryRoot(): string {
  if (!temporaryRoot) {
    const parent = join(tmpdir(), NAME);
    mkdirSync(parent, { recursive: true });
    temporaryRoot = mkdtempSync(join(parent, "session-"));
  }
  return temporaryRoot;
}

/** Choose an unambiguous Node file extension for an extensionless remote URL. */
function extensionForContentType(contentType: string): string {
  const type = contentType.toLowerCase();
  if (type.includes("text/typescript") || type.includes("application/typescript")) return ".ts";
  if (type.includes("application/json")) return ".json";
  if (type.includes("application/wasm")) return ".wasm";
  // .mjs keeps JS modules ESM regardless of package.json files above the tmp root.
  return ".mjs";
}

function safePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_.@-]/g, (character) => encodeURIComponent(character));
}

/** Map an exact HTTP URL to a unique readable module path and register its reverse mapping. */
export function urlToTmpPath(url: string, contentType = ""): string {
  const parsed = new URL(url);
  const extension = extname(parsed.pathname);
  const pathSegments = parsed.pathname.split("/").filter(Boolean).map(safePathSegment);
  const identity = createHash("sha256").update(parsed.href).digest("hex").slice(0, 16);
  const inferredExtension = KNOWN_EXTENSIONS.has(extension) ? extension : extensionForContentType(contentType);
  const path = join(getTemporaryRoot(), parsed.protocol.slice(0, -1), safePathSegment(parsed.host),
    ...pathSegments, `module-${identity}${inferredExtension}`);
  sourceUrls.set(resolve(path), parsed.href);
  return path;
}

/** Recover the original HTTP URL only for module paths generated in this session. */
export function tmpPathToUrl(fileUrl: string): string | null {
  try {
    const path = fileUrl.startsWith("file:") ? fileURLToPath(fileUrl) : fileUrl;
    return sourceUrls.get(resolve(path)) ?? null;
  } catch {
    return null;
  }
}

/** Write text or binary source atomically, creating parent directories as needed. */
export function writeTmpFile(path: string, source: ModuleSource): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomicSync(path, source);
}
