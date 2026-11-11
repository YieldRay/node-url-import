import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const capturedRequests: { server: "source" | "target"; url: string; headers: Record<string, string | string[] | undefined> }[] = [];
let targetUrl: string;
const targetServer = createServer((request, response) => {
  capturedRequests.push({ server: "target", url: request.url!, headers: request.headers });
  response.setHeader("Content-Type", "application/javascript");
  response.end("export default 42;");
});
const server = createServer((request, response) => {
  capturedRequests.push({ server: "source", url: request.url!, headers: request.headers });
  if (request.url === "/never.mjs") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.flushHeaders();
    return;
  }
  if (request.url === "/missing.mjs") {
    response.writeHead(404).end();
    return;
  }
  if (request.url === "/redirect/same") {
    response.writeHead(302, { Location: "/headers-target" }).end();
    return;
  }
  if (request.url === "/redirect/cross") {
    response.writeHead(302, { Location: `${targetUrl}/headers-target` }).end();
    return;
  }
  response.setHeader("Content-Type", "application/javascript");
  response.end("export default 42;");
});
let baseUrl: string;
let workspace: string;

before(async () => {
  await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
  const targetAddress = targetServer.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  targetUrl = `http://127.0.0.1:${targetAddress.port}`;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  targetServer.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => targetServer.close(() => resolve())),
  ]);
});
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "node-url-import-sync-test-"));
  capturedRequests.length = 0;
});
afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

function runScript(code: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DENO_DIR: join(workspace, "deno"),
      URL_IMPORT_RELOAD: "0",
      URL_IMPORT_LOCK: "",
      URL_IMPORT_FROZEN: "0",
      FORCE_COLOR: "0",
      ...extraEnv,
    };
    if (!("DENO_AUTH_TOKENS" in extraEnv)) delete env.DENO_AUTH_TOKENS;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      env,
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
  it("validates timeout and HeadersInit options on cache hits", async () => {
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { fetchModuleSync } = await import(${JSON.stringify(fetcherUrl)});
      const { writeCache } = await import(${JSON.stringify(cacheUrl)});
      const url = "https://sync-options.test/cached.mjs";
      writeCache([url], "export default 42;", "application/javascript");
      for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
        assert.throws(() => fetchModuleSync(url, { timeoutMs }), {
          name: "RangeError",
          message: "The fetch timeout must be a positive integer no greater than 2147483647",
        });
      }
      assert.throws(() => fetchModuleSync(url, { headers: [["invalid header name", "value"]] }), TypeError);
      assert.equal(fetchModuleSync(url, { timeoutMs: 2147483647 }).source, "export default 42;");
    `);
    assert.equal(result.status, 0, result.stderr);
  });

  it("passes FetchOptions headers through the worker and handles redirect credentials safely", async () => {
    const sourceHost = new URL(baseUrl).host;
    const targetHost = new URL(targetUrl).host;
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { fetchModuleSync } = await import(${JSON.stringify(fetcherUrl)});

      const recordHeaders = [["X-Record", "first"], ["X-Record", "second"], ["User-Agent", "record-agent"]];
      const objectHeaders = { "X-Object": "object-value" };
      const instanceHeaders = new Headers({
        "X-Instance": "instance-value",
        "X-Trace": "trace-value",
        "User-Agent": "caller-agent",
        Authorization: "Caller explicit",
        Cookie: "caller-cookie",
        "Proxy-Authorization": "caller-proxy",
      });

      fetchModuleSync(${JSON.stringify(`${baseUrl}/record`)}, { headers: recordHeaders });
      fetchModuleSync(${JSON.stringify(`${baseUrl}/object`)}, { headers: objectHeaders });
      fetchModuleSync(${JSON.stringify(`${baseUrl}/explicit`)}, { headers: instanceHeaders });
      fetchModuleSync(${JSON.stringify(`${baseUrl}/redirect/same`)}, { headers: instanceHeaders });
      fetchModuleSync(${JSON.stringify(`${baseUrl}/redirect/cross`)}, { headers: instanceHeaders });

      assert.equal(instanceHeaders.get("User-Agent"), "caller-agent");
      assert.equal(instanceHeaders.get("Authorization"), "Caller explicit");
      assert.equal(instanceHeaders.get("Cookie"), "caller-cookie");
      assert.equal(instanceHeaders.get("Proxy-Authorization"), "caller-proxy");
      assert.deepEqual(recordHeaders, [["X-Record", "first"], ["X-Record", "second"], ["User-Agent", "record-agent"]]);
      assert.deepEqual(objectHeaders, { "X-Object": "object-value" });
    `, {
      URL_IMPORT_RELOAD: "1",
      DENO_AUTH_TOKENS: `source-token@${sourceHost};target-token@${targetHost}`,
    });
    assert.equal(result.status, 0, result.stderr);
    const source = capturedRequests.filter((request) => request.server === "source");
    const target = capturedRequests.filter((request) => request.server === "target");
    const record = source.find((request) => request.url === "/record");
    assert.equal(record?.headers["x-record"], "first, second");
    assert.equal(record?.headers["user-agent"], "record-agent");
    assert.equal(source.find((request) => request.url === "/object")?.headers["x-object"], "object-value");
    assert.equal(source.find((request) => request.url === "/object")?.headers["user-agent"], "node-url-import");
    const explicit = source.find((request) => request.url === "/explicit")?.headers;
    assert.equal(explicit?.authorization, "Caller explicit");
    assert.equal(explicit?.["user-agent"], "caller-agent");
    assert.equal(explicit?.cookie, "caller-cookie");
    assert.equal(explicit?.["proxy-authorization"], "caller-proxy");
    const sameOrigin = source.filter((request) => request.url === "/redirect/same" || request.url === "/headers-target");
    assert.equal(sameOrigin.length, 2);
    for (const request of sameOrigin) {
      assert.equal(request.headers.authorization, "Caller explicit");
      assert.equal(request.headers.cookie, "caller-cookie");
      assert.equal(request.headers["proxy-authorization"], "caller-proxy");
      assert.equal(request.headers["x-trace"], "trace-value");
    }
    assert.equal(source.find((request) => request.url === "/redirect/cross")?.headers.authorization, "Caller explicit");
    assert.equal(target.length, 1);
    assert.equal(target[0]?.headers.authorization, "Bearer target-token");
    assert.equal(target[0]?.headers.cookie, undefined);
    assert.equal(target[0]?.headers["proxy-authorization"], undefined);
    assert.equal(target[0]?.headers["x-trace"], "trace-value");
    assert.doesNotMatch(result.stderr, /source-token|target-token|Caller explicit|caller-cookie|caller-proxy/);
  });

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

  it("normalizes cached URLs while preserving query and fragment identities", async () => {
    const result = await runScript(`
      import assert from "node:assert/strict";
      const { writeCache, readCache } = await import(${JSON.stringify(cacheUrl)});
      const { fetchModuleSync } = await import(${JSON.stringify(fetcherUrl)});
      const url = "https://modules.test/mod.mjs?q=1#identity";
      writeCache([url], "export default 42;", "application/javascript");
      for (const variant of [url, "https://MODULES.test:443/mod.mjs?q=1#identity", "HTTPS://MODULES.test:443/mod.mjs?q=1#identity", "https://modules.test/dir/../mod.mjs?q=1#identity"]) {
        assert.equal(readCache(variant).finalUrl, url);
        assert.deepEqual(fetchModuleSync(variant), fetchModuleSync(url));
      }
      assert.equal(fetchModuleSync("https://modules.test/mod.mjs?q=1#other").finalUrl, "https://modules.test/mod.mjs?q=1#other");
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
