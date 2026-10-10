import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("rejects changed redirect targets without mutating a frozen lock", async () => {
    const start = "https://lock.test/moving";
    const original = "https://lock.test/original.mjs";
    const changed = "https://lock.test/changed.mjs";
    const source = "export default 1;";
    writeLock({ redirects: { [start]: original }, remote: { [original]: hashSource(source), [changed]: hashSource(source) } });
    const previous = readFileSync(join(workspace, "deno.lock"), "utf8");
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { writeCache } = await import(${JSON.stringify(cacheUrl)});
      const { fetchModuleSync } = await import(${JSON.stringify(syncFetchUrl)});
      writeCache([${JSON.stringify(start)}, ${JSON.stringify(changed)}], ${JSON.stringify(source)}, "application/javascript");
      assert.throws(() => fetchModuleSync(${JSON.stringify(start)}));
    `, { URL_IMPORT_FROZEN: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(workspace, "deno.lock"), "utf8"), previous);
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
