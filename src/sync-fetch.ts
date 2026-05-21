/**
 * Synchronous HTTP fetch using Atomics.wait + a persistent worker thread.
 *
 * On cache hit: reads directly from disk (sync fs), no worker involved.
 * On cache miss: posts to the worker, blocks with Atomics.wait until the
 * worker completes the async fetch, then reads the result via receiveMessageOnPort.
 */

import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CacheEntry } from "./cache.ts";
import { cachePaths } from "./cache.ts";
import { MAX_REDIRECTS } from "./constants.ts";

const META_MARKER = "\n// denoCacheMetadata=";

// Lazy-initialized worker
let worker: Worker | null = null;

/**
 * Resolve the worker path relative to this file's import.meta.url.
 * Works both from source (.ts, Node 24+ or --import with TS support)
 * and from compiled output (.js).
 */
function resolveWorkerPath(): string {
  const selfUrl = import.meta.url;
  const ext = selfUrl.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./sync-fetch-worker${ext}`, selfUrl));
}

function getWorker(): Worker {
  if (!worker) {
    const w = new Worker(resolveWorkerPath());
    w.unref(); // Don't keep the process alive
    w.on("error", () => {
      // Reset so next call spawns a fresh worker
      worker = null;
    });
    w.on("exit", () => {
      worker = null;
    });
    worker = w;
  }
  return worker;
}

/**
 * Read from the Deno-format disk cache synchronously.
 * Returns null on cache miss. Follows redirect stubs up to MAX_REDIRECTS.
 */
function readCacheSync(url: string, depth = 0): CacheEntry | null {
  if (depth > MAX_REDIRECTS) return null;

  const { file } = cachePaths(url);
  if (!existsSync(file)) return null;

  try {
    const raw = readFileSync(file, "utf-8");

    // Redirect stub: entire file is \n// denoCacheMetadata=<JSON>
    if (raw.startsWith(META_MARKER)) {
      const meta = JSON.parse(raw.slice(META_MARKER.length));
      const location = meta.headers?.["location"];
      if (!location) return null;
      const resolved = new URL(location, meta.url).href;
      return readCacheSync(resolved, depth + 1);
    }

    // Source entry: <source>\n// denoCacheMetadata=<JSON>
    const metaIdx = raw.lastIndexOf(META_MARKER);
    if (metaIdx === -1) {
      // No metadata — treat whole file as source, infer content-type
      return {
        source: raw,
        contentType: inferContentType(url),
        url,
        finalUrl: url,
      };
    }

    const source = raw.slice(0, metaIdx);
    const meta = JSON.parse(raw.slice(metaIdx + META_MARKER.length));
    const contentType = meta.headers?.["content-type"] || inferContentType(url);
    return { source, contentType, url: meta.url, finalUrl: meta.url };
  } catch {
    return null;
  }
}

function inferContentType(url: string): string {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith(".json")) return "application/json";
  if (pathname.endsWith(".wasm")) return "application/wasm";
  if (pathname.endsWith(".ts") || pathname.endsWith(".tsx"))
    return "text/typescript";
  return "application/javascript";
}

interface WorkerResponse {
  error?: string;
  source?: string;
  contentType?: string;
  url?: string;
  finalUrl?: string;
}

/**
 * Fetch a module synchronously. Checks disk cache first, then
 * blocks the main thread while the worker fetches from the network.
 */
export function fetchModuleSync(url: string): CacheEntry {
  // Fast path: check disk cache synchronously
  const reload = process.env.URL_IMPORT_RELOAD === "1";
  if (!reload) {
    const cached = readCacheSync(url);
    if (cached) return cached;
  }

  // Cache miss — delegate to worker and block
  const w = getWorker();
  const sab = new SharedArrayBuffer(4);
  const signal = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();

  w.postMessage({ url, sab, port: port2 }, [port2]);

  // Block until the worker signals completion
  // Timeout after 30 seconds to avoid infinite hangs
  const result = Atomics.wait(signal, 0, 0, 30_000);
  if (result === "timed-out") {
    port1.close();
    throw new Error(`Timed out fetching ${url} (30s)`);
  }

  // Read the result from the port
  const msg = receiveMessageOnPort(port1);
  port1.close();

  if (!msg) {
    throw new Error(`No response from fetch worker for ${url}`);
  }

  const response = msg.message as WorkerResponse;
  if (response.error) {
    throw new Error(response.error);
  }

  return {
    source: response.source!,
    contentType: response.contentType!,
    url: response.url!,
    finalUrl: response.finalUrl!,
  };
}
