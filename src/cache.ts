import process from "node:process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

function defaultDenoDir(): string {
  if (process.env.DENO_DIR) return process.env.DENO_DIR;
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Caches", "deno");
    case "win32":
      return join(
        process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
        "deno",
      );
    default:
      return join(
        process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
        "deno",
      );
  }
}

const CACHE_DIR = join(defaultDenoDir(), "remote");

export interface CachePaths {
  dir: string;
  file: string;
}

export interface CacheEntry {
  /** Raw source text of the module. */
  source: string;
  /** Value of the `Content-Type` response header (e.g. `"application/javascript; charset=utf-8"`). */
  contentType: string;
  /** The URL as originally requested (before redirects). */
  url: string;
  /** The final URL after following all redirects. */
  finalUrl: string;
}

interface DenoCacheMetadata {
  headers: Record<string, string>;
  url: string;
  time: number;
}

export function cachePaths(url: string): CachePaths {
  const parsed = new URL(url);
  const hash = createHash("sha256").update(parsed.pathname).digest("hex");
  const dir = join(CACHE_DIR, parsed.protocol.replace(/:$/, ""), parsed.host);
  return { dir, file: join(dir, hash) };
}

// Deno appends this marker + JSON to the end of source files, and uses it as
// the entire content (with a leading \n) for redirect stubs.
const META_MARKER = "\n// denoCacheMetadata=";

function inferContentType(url: string): string {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith(".json")) return "application/json";
  if (pathname.endsWith(".wasm")) return "application/wasm";
  if (pathname.endsWith(".ts") || pathname.endsWith(".tsx"))
    return "text/typescript";
  return "application/javascript";
}

export async function readCache(url: string): Promise<CacheEntry | null> {
  const { file } = cachePaths(url);
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, "utf-8");

    // Redirect stub: entire file is \n// denoCacheMetadata=<JSON>
    if (raw.startsWith(META_MARKER)) {
      const meta: DenoCacheMetadata = JSON.parse(raw.slice(META_MARKER.length));
      const location = meta.headers["location"];
      if (!location) return null;
      const resolved = new URL(location, meta.url).href;
      const result = await readCache(resolved);
      if (result) return { ...result, url };
      return null;
    }

    // Source entry: <source>\n// denoCacheMetadata=<JSON>
    const metaIdx = raw.lastIndexOf(META_MARKER);
    if (metaIdx === -1) {
      // No metadata — treat whole file as source, infer content-type
      return { source: raw, contentType: inferContentType(url), url, finalUrl: url };
    }
    const source = raw.slice(0, metaIdx);
    const meta: DenoCacheMetadata = JSON.parse(raw.slice(metaIdx + META_MARKER.length));
    const contentType = meta.headers["content-type"] || inferContentType(url);
    return { source, contentType, url: meta.url, finalUrl: meta.url };
  } catch {
    return null;
  }
}

// redirectChain is the full list of URLs traversed: [original, ...intermediates, final]
export async function writeCache(
  redirectChain: string[],
  source: string,
  contentType: string,
): Promise<void> {
  const finalUrl = redirectChain[redirectChain.length - 1]!;

  // Write a redirect stub for every hop except the last
  for (let i = 0; i < redirectChain.length - 1; i++) {
    const from = redirectChain[i]!;
    const to = redirectChain[i + 1]!;
    const { dir, file } = cachePaths(from);
    await mkdir(dir, { recursive: true });
    const meta: DenoCacheMetadata = {
      headers: { "content-length": "0", location: to },
      url: from,
      time: Math.floor(Date.now() / 1000),
    };
    await writeFile(file, META_MARKER + JSON.stringify(meta), "utf-8");
  }

  // Write source entry: <source>\n// denoCacheMetadata=<JSON>
  const { dir, file } = cachePaths(finalUrl);
  await mkdir(dir, { recursive: true });
  const meta: DenoCacheMetadata = {
    headers: { "content-type": contentType },
    url: finalUrl,
    time: Math.floor(Date.now() / 1000),
  };
  await writeFile(file, source + META_MARKER + JSON.stringify(meta), "utf-8");
}

/** Remove all cached remote modules from `$DENO_DIR/remote/`. */
export async function clearCache(): Promise<void> {
  await rm(CACHE_DIR, { recursive: true, force: true });
}
