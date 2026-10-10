import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const server = createServer((request, response) => {
  if (request.url === "/never.mjs") return;
  if (request.url === "/missing.mjs") {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("Content-Type", "application/javascript");
  response.end("export default 42;");
});
let baseUrl: string;
let workspace: string;

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
beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "node-url-import-sync-test-")); });
afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

function runScript(code: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      env: { ...process.env, DENO_DIR: join(workspace, "deno") },
      stdio: ["ignore", "pipe", "pipe"], timeout: 5_000, killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const fetcherUrl = new URL("./sync-fetch.ts", import.meta.url).href;
const cacheUrl = new URL("./cache.ts", import.meta.url).href;

describe("synchronous fetch worker", () => {
  it("fetches and reuses cache entries without inheriting eval-only Node flags", async () => {
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { fetchModuleSync } = await import(${JSON.stringify(fetcherUrl)});
      const first = fetchModuleSync(${JSON.stringify(`${baseUrl}/module.mjs`)});
      const second = fetchModuleSync(${JSON.stringify(`${baseUrl}/module.mjs`)});
      assert.equal(first.source, "export default 42;");
      assert.deepEqual(second, first);
    `);
    assert.equal(result.status, 0, result.stderr);
  });

  it("recovers after a normal network failure", async () => {
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { fetchModuleSync } = await import(${JSON.stringify(fetcherUrl)});
      assert.throws(() => fetchModuleSync(${JSON.stringify(`${baseUrl}/missing.mjs`)}));
      assert.equal(fetchModuleSync(${JSON.stringify(`${baseUrl}/recovered.mjs`)}).source, "export default 42;");
    `);
    assert.equal(result.status, 0, result.stderr);
  });

  it("bounds worker failure waits and restarts the worker for later requests", async () => {
    const result = await runScript(`
      import assert from "node:assert/strict";
      import { Worker } from "node:worker_threads";
      const { fetchModuleSync } = await import(${JSON.stringify(fetcherUrl)});
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function () { void this.terminate(); };
      try {
        assert.throws(() => fetchModuleSync(${JSON.stringify(`${baseUrl}/crashed.mjs`)}, { timeoutMs: 100 }));
      } finally {
        Worker.prototype.postMessage = postMessage;
      }
      assert.equal(fetchModuleSync(${JSON.stringify(`${baseUrl}/after-crash.mjs`)}).source, "export default 42;");
    `);
    assert.equal(result.status, 0, result.stderr);
  });

  it("times out a stalled response without caching it or breaking later requests", async () => {
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { fetchModuleSync } = await import(${JSON.stringify(fetcherUrl)});
      const { readCache } = await import(${JSON.stringify(cacheUrl)});
      assert.throws(() => fetchModuleSync(${JSON.stringify(`${baseUrl}/never.mjs`)}, { timeoutMs: 200 }));
      assert.equal(readCache(${JSON.stringify(`${baseUrl}/never.mjs`)}), null);
      assert.equal(fetchModuleSync(${JSON.stringify(`${baseUrl}/after-timeout.mjs`)}).source, "export default 42;");
    `);
    assert.equal(result.status, 0, result.stderr);
  });
});
