/**
 * Worker thread that performs async HTTP fetch on behalf of the main thread.
 *
 * Communication protocol:
 *   Main → Worker: { url: string, sab: SharedArrayBuffer, port: MessagePort }
 *   Worker → Main: posts result on port, then signals via Atomics.notify(sab)
 *
 * The worker stays alive to amortise startup cost across multiple fetches.
 */

import { parentPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { fetchModule } from "./fetch.ts";
import type { ModuleSource } from "./cache.ts";

interface FetchRequest {
  url: string;
  sab: SharedArrayBuffer;
  port: MessagePort;
}

interface FetchResponse {
  error?: string;
  source?: ModuleSource;
  contentType?: string;
  url?: string;
  finalUrl?: string;
  redirectChain?: string[];
}

parentPort!.on("message", async (msg: FetchRequest) => {
  const { url, sab, port } = msg;
  const signal = new Int32Array(sab);

  let response: FetchResponse;
  try {
    const result = await fetchModule(url);
    response = {
      source: result.source,
      contentType: result.contentType,
      url: result.url,
      finalUrl: result.finalUrl,
      redirectChain: result.redirectChain,
    };
  } catch (err) {
    response = {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Post the result data on the transferred port
  port.postMessage(response);
  port.close();

  // Signal the main thread that the result is ready
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
