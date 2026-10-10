import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashSource } from "./lock.ts";

let workspace: string;
let baseUrl: string;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/javascript");
  response.end(`export default ${JSON.stringify(request.url)};`);
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "node-url-import-lock-test-")); });
afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

function runScript(code: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", new URL("./register-hooks.ts", import.meta.url).href,
      "--input-type=module", "--eval", code], {
      env: { ...process.env, DENO_DIR: join(workspace, "deno"), URL_IMPORT_LOCK: join(workspace, "deno.lock"), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const cacheUrl = new URL("./cache.ts", import.meta.url).href;
const fetchUrl = new URL("./fetch.ts", import.meta.url).href;
const syncFetchUrl = new URL("./sync-fetch.ts", import.meta.url).href;
const lockUrl = new URL("./lock.ts", import.meta.url).href;

function writeLock(data: object): void {
  writeFileSync(join(workspace, "deno.lock"), JSON.stringify({ version: "5", ...data }));
}

function readLock(): Record<string, unknown> & { remote: Record<string, string> } {
  return JSON.parse(readFileSync(join(workspace, "deno.lock"), "utf8"));
}

describe("lock file", () => {
  it("computes Deno-compatible source hashes", () => {
    assert.equal(hashSource("hello world"), "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("verifies cached content in both synchronous and asynchronous fetches", async () => {
    const url = "https://lock.test/cached.mjs";
    writeLock({ remote: { [url]: hashSource("export default 1;") } });
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { writeCache } = await import(${JSON.stringify(cacheUrl)});
      const { fetchModule } = await import(${JSON.stringify(fetchUrl)});
      const { fetchModuleSync } = await import(${JSON.stringify(syncFetchUrl)});
      writeCache([${JSON.stringify(url)}], "export default 999;", "application/javascript");
      assert.throws(() => fetchModuleSync(${JSON.stringify(url)}));
      await assert.rejects(fetchModule(${JSON.stringify(url)}));
    `, { URL_IMPORT_FROZEN: "1" });
    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects cached modules when a frozen lock file is missing", async () => {
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { writeCache } = await import(${JSON.stringify(cacheUrl)});
      const { fetchModuleSync } = await import(${JSON.stringify(syncFetchUrl)});
      writeCache(["https://lock.test/missing.mjs"], "export default 1;", "application/javascript");
      assert.throws(() => fetchModuleSync("https://lock.test/missing.mjs"));
    `, { URL_IMPORT_FROZEN: "1" });
    assert.equal(result.status, 0, result.stderr);
  });

  it("never caches or executes a response rejected by a frozen lock", async () => {
    const url = `${baseUrl}/untrusted.mjs`;
    writeLock({ remote: { [url]: hashSource("export default 1;") } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runScript(`
        import assert from "node:assert/strict";
        const { readCache } = await import(${JSON.stringify(cacheUrl)});
        await assert.rejects(import(${JSON.stringify(url)}));
        assert.equal(readCache(${JSON.stringify(url)}), null);
      `, { URL_IMPORT_FROZEN: "1" });
      assert.equal(result.status, 0, result.stderr);
    }
  });

  it("records cached modules without discarding unrelated Deno lock sections", async () => {
    const preserved = {
      specifiers: { "npm:typescript@6": "6.0.3" },
      npm: { "typescript@6.0.3": { integrity: "fixture" } },
      jsr: { "@std/encoding@1.0.0": { integrity: "fixture" } },
      workspace: { dependencies: ["npm:typescript@6"] },
    };
    writeLock({ ...preserved, remote: {} });
    const url = "https://lock.test/new.mjs";
    const result = await runScript(`
      const { writeCache } = await import(${JSON.stringify(cacheUrl)});
      const { fetchModuleSync } = await import(${JSON.stringify(syncFetchUrl)});
      writeCache([${JSON.stringify(url)}], "export default 1;", "application/javascript");
      fetchModuleSync(${JSON.stringify(url)});
    `);
    assert.equal(result.status, 0, result.stderr);
    const lock = readLock();
    assert.equal(lock.remote[url], hashSource("export default 1;"));
    for (const [key, value] of Object.entries(preserved)) assert.deepEqual(lock[key], value);
  });

  it("accepts Deno hop-by-hop redirects from disk in frozen mode", async () => {
    const chain = ["https://lock.test/start", "https://lock.test/middle", "https://lock.test/final.mjs"];
    writeLock({ redirects: { [chain[0]!]: chain[1], [chain[1]!]: chain[2] }, remote: { [chain[2]!]: hashSource("export default 1;") } });
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { writeCache } = await import(${JSON.stringify(cacheUrl)});
      const { fetchModule } = await import(${JSON.stringify(fetchUrl)});
      const { fetchModuleSync } = await import(${JSON.stringify(syncFetchUrl)});
      writeCache(${JSON.stringify(chain)}, "export default 1;", "application/javascript");
      assert.equal(fetchModuleSync(${JSON.stringify(chain[0])}).finalUrl, ${JSON.stringify(chain[2])});
      assert.equal((await fetchModule(${JSON.stringify(chain[0])})).finalUrl, ${JSON.stringify(chain[2])});
    `, { URL_IMPORT_FROZEN: "1" });
    assert.equal(result.status, 0, result.stderr);
  });

  it("retains records added by both the loader worker and programmatic API", async () => {
    const urls = ["/first.mjs", "/api.mjs", "/last.mjs"].map((path) => baseUrl + path);
    const result = await runScript(`
      const { fetchModule } = await import(${JSON.stringify(fetchUrl)});
      await import(${JSON.stringify(urls[0])});
      await fetchModule(${JSON.stringify(urls[1])});
      await import(${JSON.stringify(urls[2])});
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(readLock().remote).sort(), urls.sort());
  });

  it("merges concurrent writers without losing module records", async () => {
    const urls = Array.from({ length: 6 }, (_, index) => `${baseUrl}/concurrent-${index}.mjs`);
    const results = await Promise.all(urls.map((url) => runScript(`
      const { fetchModule } = await import(${JSON.stringify(fetchUrl)});
      await fetchModule(${JSON.stringify(url)});
    `)));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(readLock().remote).sort(), urls.sort());
  });

  it("uses Deno's recorded redirects instead of newer cached targets", async () => {
    const start = "https://lock.test/moving#entry";
    const original = "https://lock.test/original.mjs#locked";
    const changed = "https://lock.test/changed.mjs";
    const source = "export default 1;";
    writeLock({ redirects: { [start]: original }, remote: { [original]: hashSource(source) } });
    const previous = readFileSync(join(workspace, "deno.lock"), "utf8");
    for (const frozen of ["0", "1"]) {
      const result = await runScript(`
        import assert from "node:assert/strict";
        const { writeCache } = await import(${JSON.stringify(cacheUrl)});
        const { fetchModule } = await import(${JSON.stringify(fetchUrl)});
        const { fetchModuleSync } = await import(${JSON.stringify(syncFetchUrl)});
        writeCache([${JSON.stringify(original)}], ${JSON.stringify(source)}, "application/javascript");
        writeCache([${JSON.stringify(start)}, ${JSON.stringify(changed)}], "export default 999;", "application/javascript");
        const sync = fetchModuleSync(${JSON.stringify(start)});
        const async = await fetchModule(${JSON.stringify(start)});
        assert.equal(sync.finalUrl, ${JSON.stringify(original)});
        assert.deepEqual(async, sync);
        assert.deepEqual(sync.redirectChain, [${JSON.stringify(start)}, ${JSON.stringify(original)}]);
      `, { URL_IMPORT_FROZEN: frozen });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(workspace, "deno.lock"), "utf8"), previous);
    }
  });

  it("records full URL fragments and sorted remote keys in Deno v5 format", async () => {
    const result = await runScript(`
      const { writeCache } = await import(${JSON.stringify(cacheUrl)});
      const { fetchModuleSync } = await import(${JSON.stringify(syncFetchUrl)});
      const chain = ["https://lock.test/z-start#entry", "https://lock.test/middle#next", "https://lock.test/z-final.mjs#final"];
      writeCache(chain, "export default 1;", "application/javascript");
      fetchModuleSync(chain[0]);
      writeCache(["https://lock.test/a.mjs#other"], "export default 1;", "application/javascript");
      fetchModuleSync("https://lock.test/a.mjs#other");
    `);
    assert.equal(result.status, 0, result.stderr);
    const lock = readLock();
    assert.equal(lock.version, "5");
    assert.deepEqual(lock.redirects, {
      "https://lock.test/middle#next": "https://lock.test/z-final.mjs#final",
      "https://lock.test/z-start#entry": "https://lock.test/middle#next",
    });
    assert.deepEqual(Object.keys(lock.remote), ["https://lock.test/a.mjs#other", "https://lock.test/z-final.mjs#final"]);
  });

  it("ignores frozen mode when no lock file is enabled, like Deno --no-lock", async () => {
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { writeCache } = await import(${JSON.stringify(cacheUrl)});
      const { fetchModuleSync } = await import(${JSON.stringify(syncFetchUrl)});
      writeCache(["https://lock.test/unlocked.mjs"], "export default 42;", "application/javascript");
      assert.equal(fetchModuleSync("https://lock.test/unlocked.mjs").source, "export default 42;");
    `, { URL_IMPORT_LOCK: "", URL_IMPORT_FROZEN: "1" });
    assert.equal(result.status, 0, result.stderr);
  });

  it("serializes concurrent writers using symlink aliases of the same lock file", async () => {
    const path = join(workspace, "deno.lock");
    const alias = join(workspace, "alias.lock");
    writeLock({ remote: {}, workspace: { padding: " ".repeat(256 * 1024) } });
    symlinkSync(path, alias);
    const result = await runScript(`
      import assert from "node:assert/strict";
      import { Worker } from "node:worker_threads";
      import { setTimeout } from "node:timers/promises";
      const barrier = new Int32Array(new SharedArrayBuffer(8));
      const workers = Array.from({ length: 4 }, (_, id) => new Worker(\`
        const { workerData } = await import("node:worker_threads");
        const { verifyLock } = await import(workerData.lockUrl);
        const barrier = new Int32Array(workerData.barrier);
        Atomics.add(barrier, 0, 1);
        Atomics.wait(barrier, 1, 0);
        for (let index = 0; index < 16; index++) {
          verifyLock("https://lock.test/alias-" + workerData.id + "-" + index + ".mjs", "export default 42;");
        }
      \`, {
        eval: true, execArgv: [],
        env: { ...process.env, URL_IMPORT_LOCK: id % 2 ? ${JSON.stringify(alias)} : ${JSON.stringify(path)} },
        workerData: { id, barrier: barrier.buffer, lockUrl: ${JSON.stringify(lockUrl)} },
      }));
      const completions = workers.map(worker => new Promise((resolve, reject) => {
        worker.on("error", reject);
        worker.on("exit", code => code === 0 ? resolve() : reject(new Error("Worker failed")));
      }));
      try {
        const deadline = Date.now() + 5_000;
        while (Atomics.load(barrier, 0) < workers.length && Date.now() < deadline) await setTimeout(5);
        assert.equal(Atomics.load(barrier, 0), workers.length);
        Atomics.store(barrier, 1, 1);
        Atomics.notify(barrier, 1);
        await Promise.all(completions);
      } finally {
        Atomics.store(barrier, 1, 1);
        Atomics.notify(barrier, 1);
        await Promise.all(workers.map(worker => worker.terminate()));
      }
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Object.keys(readLock().remote).length, 64);
    assert.equal(lstatSync(alias).isSymbolicLink(), true);
    assert.deepEqual(readFileSync(alias), readFileSync(path));
  });

  it("does not replace malformed locks with a new empty lock", async () => {
    const invalid = '{"version":"5","remote":null}';
    writeFileSync(join(workspace, "deno.lock"), invalid);
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { writeCache } = await import(${JSON.stringify(cacheUrl)});
      const { fetchModule } = await import(${JSON.stringify(fetchUrl)});
      writeCache(["https://lock.test/invalid.mjs"], "export default 1;", "application/javascript");
      await assert.rejects(fetchModule("https://lock.test/invalid.mjs"));
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(workspace, "deno.lock"), "utf8"), invalid);
  });
});
