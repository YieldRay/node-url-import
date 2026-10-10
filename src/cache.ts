import process from "node:process";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { MAX_REDIRECTS } from "./constants.ts";

function defaultDenoDir(): string {
  if (process.env.DENO_DIR) return process.env.DENO_DIR;
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Caches", "deno");
    case "win32":
      return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "deno");
    default:
      return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "deno");
  }
}

const CACHE_DIR = join(defaultDenoDir(), "remote");
// Deno appends this marker + JSON after source bytes and uses it alone for
// redirect stubs. Keep this byte format stable so both runtimes share the cache.
const META_MARKER = Buffer.from("\n// denoCacheMetadata=");

export type ModuleSource = string | Uint8Array;

export interface CachePaths {
  dir: string;
  file: string;
}

export interface CacheEntry {
  /** Raw source text, or untouched bytes for a WebAssembly module. */
  source: ModuleSource;
  /** Value of the Content-Type response header, including any parameters. */
  contentType: string;
  /** The URL as originally requested, including its module-identity fragment. */
  url: string;
  /** The final URL after following all redirects. */
  finalUrl: string;
  /** Every URL traversed: [original, ...intermediates, final]. */
  redirectChain: string[];
}

interface DenoCacheMetadata {
  headers: Record<string, string>;
  url: string;
  time: number;
}

/** Deno hashes pathname + query; fragments identify modules, not HTTP responses. */
export function cachePaths(url: string): CachePaths {
  const parsed = new URL(url);
  const hash = createHash("sha256").update(parsed.pathname + parsed.search).digest("hex");
  const host = parsed.hostname.replaceAll(":", "_") + (parsed.port ? `_PORT${parsed.port}` : "");
  const dir = join(CACHE_DIR, parsed.protocol.slice(0, -1), host);
  return { dir, file: join(dir, hash) };
}

function inferContentType(url: string): string {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith(".json")) return "application/json";
  if (pathname.endsWith(".wasm")) return "application/wasm";
  if (/\.(?:ts|tsx|mts|cts)$/.test(pathname)) return "text/typescript";
  return "application/javascript";
}

/** Decode text modules while retaining the binary source required by Wasm loaders. */
export function decodeModuleSource(bytes: Uint8Array, url: string, contentType: string): ModuleSource {
  if (contentType.toLowerCase().includes("application/wasm") || new URL(url).pathname.endsWith(".wasm")) {
    return bytes;
  }
  return new TextDecoder().decode(bytes);
}

function isMetadata(value: unknown): value is DenoCacheMetadata {
  return typeof value === "object" && value !== null &&
    "url" in value && typeof value.url === "string" &&
    "headers" in value && typeof value.headers === "object" && value.headers !== null &&
    !Array.isArray(value.headers) && Object.values(value.headers).every((header) => typeof header === "string");
}

function withoutFragment(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

/** Read source bytes or follow Deno redirect stubs; incomplete entries are misses. */
export function readCache(url: string, depth = 0): CacheEntry | null {
  if (depth > MAX_REDIRECTS) return null;
  try {
    const raw = readFileSync(cachePaths(url).file);
    const metadataOffset = raw.lastIndexOf(META_MARKER);
    if (metadataOffset === -1) return null;
    const metadata: unknown = JSON.parse(raw.subarray(metadataOffset + META_MARKER.length).toString("utf8"));
    if (!isMetadata(metadata) || withoutFragment(metadata.url) !== withoutFragment(url)) return null;

    // A Location header distinguishes redirect stubs from valid empty modules.
    const location = metadata.headers.location;
    if (location) {
      const target = new URL(location, url);
      if (!location.includes("#")) target.hash = new URL(url).hash;
      const entry = readCache(target.href, depth + 1);
      return entry ? { ...entry, url, redirectChain: [url, ...entry.redirectChain] } : null;
    }

    // Source entry: <source bytes> followed by the metadata marker and JSON.
    const contentType = metadata.headers["content-type"] || inferContentType(url);
    return {
      source: decodeModuleSource(raw.subarray(0, metadataOffset), url, contentType),
      contentType,
      url,
      finalUrl: url,
      redirectChain: [url],
    };
  } catch {
    return null;
  }
}

/**
 * Replace a file only after its complete contents are on disk. A sibling temp
 * file keeps rename atomic, preserves existing modes, and is cleaned on errors.
 * Shared by the remote cache, lock file and readable temporary modules.
 */
export function writeFileAtomicSync(path: string, source: ModuleSource): void {
  let target = path;
  let mode = 0o666;
  try {
    target = realpathSync(path);
    mode = statSync(target).mode & 0o777;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  mkdirSync(dirname(target), { recursive: true });
  const temporaryPath = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    writeFileSync(descriptor, source);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, target);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

/** Write one Deno-format stub per redirect hop plus the final source entry. */
export function writeCache(redirectChain: string[], source: ModuleSource, contentType: string): void {
  const finalUrl = redirectChain.at(-1);
  if (!finalUrl) throw new TypeError("A cache entry must have a URL");

  const writeEntry = (url: string, bytes: Uint8Array, headers: Record<string, string>): void => {
    const { dir, file } = cachePaths(url);
    mkdirSync(dir, { recursive: true });
    const metadata: DenoCacheMetadata = { headers, url: withoutFragment(url), time: Math.floor(Date.now() / 1000) };
    writeFileAtomicSync(file, Buffer.concat([bytes, META_MARKER, Buffer.from(JSON.stringify(metadata))]));
  };

  // Publish the source before its stubs so a reader never follows a new stub
  // to a source entry that has not been written yet.
  writeEntry(finalUrl, typeof source === "string" ? Buffer.from(source) : source, { "content-type": contentType });
  for (let index = redirectChain.length - 2; index >= 0; index--) {
    writeEntry(redirectChain[index]!, Buffer.alloc(0), {
      "content-length": "0",
      location: withoutFragment(redirectChain[index + 1]!),
    });
  }
}

/** Remove all cached remote modules from $DENO_DIR/remote/. */
export function clearCache(): void {
  rmSync(CACHE_DIR, { recursive: true, force: true });
}
