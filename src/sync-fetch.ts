/**
 * Synchronous module fetcher.
 *
 * On cache hit: reads from disk cache (sync).
 * On cache miss: blocks via Atomics.wait while a persistent worker thread
 * does the async HTTP fetch, then reads the result via receiveMessageOnPort.
 */

import {
  Worker,
  MessageChannel,
  receiveMessageOnPort,
} from "node:worker_threads";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readCache } from "./cache.ts";
import type { CacheEntry } from "./cache.ts";

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
    // Use an empty execArgv so the worker doesn't inherit flags from the parent
    // that are invalid for worker threads (e.g. --input-type, --tls-cipher-list).
    const w = new Worker(resolveWorkerPath(), { execArgv: [] });
    w.unref(); // Don't keep the process alive
    w.on("error", () => {
      worker = null;
    });
    w.on("exit", () => {
      worker = null;
    });
    worker = w;
  }
  return worker;
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
    const cached = readCache(url);
    if (cached) return cached;
  }

  // Cache miss — delegate to worker and block
  const w = getWorker();
  const sab = new SharedArrayBuffer(4);
  const signal = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();

  w.postMessage({ url, sab, port: port2 }, [port2]);

  // Block until the worker signals completion (no timeout, matching Deno).
  if (Atomics.wait(signal, 0, 0) === "timed-out") {
    port1.close();
    throw new Error(`Timed out fetching ${url}`);
  }

  // Read the result from the port
  const msg = receiveMessageOnPort(port1);
  port1.close();

  if (!msg) {
    throw new Error(`No response from fetch worker for ${url}`);
  }

  const response = msg.message as WorkerResponse;
  if (response.error) {
    throw new Error(`Error fetching ${url}: ${response.error}`);
  }

  return {
    source: response.source!,
    contentType: response.contentType!,
    url: response.url!,
    finalUrl: response.finalUrl!,
  };
}
