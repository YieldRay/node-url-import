import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { fetchModule } from "./fetch.ts";
import { cachePaths, readCache, writeCache } from "./cache.ts";

const requests: string[] = [];
const wasmBytes = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0,
  7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11,
  0, 3, 1, 120, 255,
]);
const server = createServer((request, response) => {
  requests.push(request.url!);
  if (request.url === "/missing.mjs") {
    response.writeHead(404).end();
    return;
  }
  if (request.url === "/binary.wasm") {
    response.setHeader("Content-Type", "application/wasm");
    response.end(wasmBytes);
    return;
  }
  response.setHeader("Content-Type", "application/javascript");
  response.end(request.url === "/empty.mjs" ? "" : `export default ${JSON.stringify(request.url)};`);
});
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { requests.length = 0; });
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(cachePaths(baseUrl).dir, { recursive: true, force: true });
});

describe("fetchModule", () => {
  it("rejects unsuccessful responses without preventing later downloads", async () => {
    await assert.rejects(fetchModule(`${baseUrl}/missing.mjs`));
    const result = await fetchModule(`${baseUrl}/available.mjs`);
    assert.equal(result.source, 'export default "/available.mjs";');
  });

  it("caches query variants independently", async () => {
    const firstUrl = `${baseUrl}/module.mjs?target=node`;
    const secondUrl = `${baseUrl}/module.mjs?target=es2022`;
    const first = await fetchModule(firstUrl);
    const second = await fetchModule(secondUrl);
    assert.notEqual(first.source, second.source);
    assert.equal(first.finalUrl, firstUrl);
    assert.equal(second.finalUrl, secondUrl);
    assert.deepEqual(requests, ["/module.mjs?target=node", "/module.mjs?target=es2022"]);
    assert.equal((await fetchModule(firstUrl)).source, first.source);
    assert.equal((await fetchModule(secondUrl)).source, second.source);
    assert.equal(requests.length, 2);
  });

  it("keeps fragment module identities while sharing their response bytes", async () => {
    const url = `${baseUrl}/fragments.mjs`;
    const first = await fetchModule(`${url}#first`);
    const second = await fetchModule(`${url}#second`);
    assert.equal(first.source, second.source);
    assert.equal(second.url, `${url}#second`);
    assert.equal(second.finalUrl, `${url}#second`);
    const modules = await Promise.all([import(`${url}#first`), import(`${url}#second`)]);
    assert.notEqual(modules[0], modules[1]);
    assert.equal(requests.length, 1);
  });

  it("caches and loads empty modules", async () => {
    const url = `${baseUrl}/empty.mjs`;
    assert.equal((await fetchModule(url)).source, "");
    assert.equal((await fetchModule(url)).source, "");
    assert.deepEqual(Object.keys(await import(url)), []);
    assert.equal(requests.length, 1);
  });

  it("preserves binary bytes through fetching, caching and module loading", async () => {
    const url = `${baseUrl}/binary.wasm`;
    const first = await fetchModule(url);
    assert.ok(first.source instanceof Uint8Array);
    assert.deepEqual(first.source, wasmBytes);
    const cached = await fetchModule(url);
    assert.ok(cached.source instanceof Uint8Array);
    assert.deepEqual([...cached.source], [...wasmBytes]);
    assert.equal((await import(url)).answer(), 42);
    assert.equal(requests.length, 1);
  });

  it("uses Deno-compatible names for port-specific cache entries", () => {
    const paths = cachePaths("http://127.0.0.1:49653/module.mjs?v=1");
    assert.ok(paths.dir.endsWith("127.0.0.1_PORT49653"));
    assert.ok(paths.file.endsWith("b22a08393817249b690133d8752be02b19e58c8ebe530a7b4d67a4d3eacaaa93"));
  });

  it("rejects incomplete cache writes instead of executing partial source", () => {
    const url = `${baseUrl}/incomplete.mjs`;
    writeCache([url], "export default 1;", "application/javascript");
    const path = cachePaths(url).file;
    const complete = readFileSync(path);
    writeFileSync(path, complete.subarray(0, 10));
    assert.equal(readCache(url), null);
  });

  it("never exposes partially written entries to concurrent readers", async () => {
    const url = `${baseUrl}/concurrent.mjs`;
    const source = "export default 1;\n" + " ".repeat(2 * 1024 * 1024);
    writeCache([url], source, "application/javascript");
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const writer = new Worker(`
      const { workerData } = await import("node:worker_threads");
      const { writeCache } = await import(workerData.cacheUrl);
      try {
        for (let index = 0; index < 12; index++) {
          writeCache([workerData.url], workerData.source, "application/javascript");
        }
      } finally {
        Atomics.store(new Int32Array(workerData.signal), 0, 1);
      }
    `, {
      eval: true,
      execArgv: [],
      workerData: { cacheUrl: new URL("./cache.ts", import.meta.url).href, url, source, signal: signal.buffer },
    });
    try {
      const deadline = Date.now() + 10_000;
      while (Atomics.load(signal, 0) === 0 && Date.now() < deadline) {
        const entry = readCache(url);
        assert.ok(entry && typeof entry.source === "string");
        assert.equal(Buffer.byteLength(entry.source), Buffer.byteLength(source));
        assert.equal(entry.source, source);
      }
      assert.equal(Atomics.load(signal, 0), 1);
    } finally {
      await writer.terminate();
    }
  });
});
