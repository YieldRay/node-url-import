/**
 * Persistent network worker for synchronous hooks.
 * Main → worker: { url, timeoutMs, signal: SharedArrayBuffer, port }.
 * Worker → main: post { entry } or { error }, then notify the shared signal.
 * Posting before notification lets receiveMessageOnPort read the result even
 * while the main thread's event loop remains blocked.
 */

import { parentPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { fetchModule } from "./fetch.ts";
import type { CacheEntry } from "./cache.ts";

interface FetchRequest {
  url: string;
  timeoutMs: number;
  signal: SharedArrayBuffer;
  port: MessagePort;
}

type FetchResponse = { entry: CacheEntry } | { error: string };

parentPort!.on("message", async ({ url, timeoutMs, signal: buffer, port }: FetchRequest) => {
  const signal = new Int32Array(buffer);
  let response: FetchResponse;
  try {
    response = { entry: await fetchModule(url, { signal: AbortSignal.timeout(timeoutMs) }) };
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }
  try {
    port.postMessage(response);
  } finally {
    // Always release the wait, including when sending the response fails.
    port.close();
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
});
