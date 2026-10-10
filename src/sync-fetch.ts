/**
 * Synchronous module fetcher.
 *
 * Cache hits are read and verified synchronously. On a miss, a persistent worker
 * performs the asynchronous HTTP request while this thread waits on Atomics.
 * Completion data arrives on a transferred port; the bounded wait also handles
 * worker startup failures whose error events cannot run while this thread blocks.
 */

import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readCache } from "./cache.ts";
import type { CacheEntry } from "./cache.ts";
import { resolveLockRedirects, verifyModuleLock } from "./lock.ts";
import { FETCH_TIMEOUT_MS, MAX_REDIRECTS, isHttpUrl } from "./constants.ts";

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    // Resolve relative to this module so source .ts and published .js both work.
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const path = fileURLToPath(new URL(`./sync-fetch-worker${extension}`, import.meta.url));
    // Hook and eval flags must never be inherited by the network worker.
    const current = new Worker(path, { execArgv: [] });
    current.unref();
    const reset = (): void => { if (worker === current) worker = null; };
    current.on("error", reset);
    current.on("exit", reset);
    worker = current;
  }
  return worker;
}

function discardWorker(current: Worker): void {
  if (worker === current) worker = null;
  void current.terminate();
}

export interface SyncFetchOptions {
  /** Maximum blocking time, including worker startup; defaults to 60 seconds. */
  timeoutMs?: number;
}

type WorkerResponse = { entry: CacheEntry } | { error: string };

/** Fetch synchronously from verified disk cache or the network worker. */
export function fetchModuleSync(url: string, options: SyncFetchOptions = {}): CacheEntry {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("The fetch timeout must be positive and finite");
  url = new URL(url).href;
  if (!isHttpUrl(url)) throw new TypeError(`Expected an HTTP(S) module URL: ${url}`);
  if (process.env.URL_IMPORT_RELOAD !== "1") {
    const lockedChain = resolveLockRedirects(url);
    const cached = readCache(lockedChain.at(-1)!);
    if (cached) {
      const entry = { ...cached, url, redirectChain: [...lockedChain.slice(0, -1), ...cached.redirectChain] };
      if (entry.redirectChain.length > MAX_REDIRECTS + 1) throw new Error(`Too many redirects fetching ${url}`);
      verifyModuleLock(entry);
      return entry;
    }
  }

  const current = getWorker();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  try {
    try {
      current.postMessage({ url, timeoutMs, signal: signal.buffer, port: port2 }, [port2]);
    } catch (error) {
      discardWorker(current);
      throw error;
    }
    // Worker error/exit callbacks cannot execute during Atomics.wait. On timeout,
    // clear the cached worker immediately so a subsequent request can restart it.
    if (Atomics.wait(signal, 0, 0, timeoutMs) === "timed-out") {
      discardWorker(current);
      throw new Error(`Timed out fetching ${url}`);
    }
    const message = receiveMessageOnPort(port1);
    if (!message) {
      discardWorker(current);
      throw new Error(`No response from fetch worker for ${url}`);
    }
    const response = message.message as WorkerResponse;
    if ("error" in response) throw new Error(`Error fetching ${url}: ${response.error}`);
    verifyModuleLock(response.entry);
    return response.entry;
  } finally {
    port1.close();
    port2.close();
  }
}
