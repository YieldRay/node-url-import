import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requests: string[] = [];
const server = createServer((request, response) => {
  requests.push(request.url!);
  const redirects: Record<string, string> = {
    "/entry.mjs": "/v1/main.mjs",
    "/v1/child.mjs": "/v2/child.mjs",
  };
  const redirect = redirects[request.url!];
  if (redirect) {
    response.writeHead(302, { Location: redirect }).end();
    return;
  }
  response.setHeader("Content-Type", request.url === "/typed.cts" ? "text/typescript" : "application/javascript");
  const sources: Record<string, string> = {
    "/v1/main.mjs": 'import { value, location } from "./child.mjs"; console.log(JSON.stringify({ value, location, main: import.meta.main, url: import.meta.url }));',
    "/v2/child.mjs": 'export { default as value } from "./dep.mjs"; export const location = import.meta.url;',
    "/v2/dep.mjs": 'export default "correct";',
    "/v1/dep.mjs": 'export default "wrong";',
    "/reload.mjs": 'export default 42;',
    "/cdn/node-url-import-uninstalled@2/sub": 'export default 73;',
    "/typed.cts": 'const value: number = 17; module.exports = value;',
    "/npm-parent.mjs": 'import ts from "npm:typescript@6"; console.log(JSON.stringify({ version: ts.version }));',
    "/cjs/main.cjs": 'module.exports = require("./child.cjs");',
    "/cjs/child.cjs": 'module.exports = 42;',
  };
  response.end(sources[request.url!] ?? 'throw new Error("Unexpected module");');
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
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "node-url-import-resolve-test-"));
  requests.length = 0;
});
afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, DENO_DIR: join(workspace, "deno"), TMPDIR: workspace, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const registerUrl = new URL("./register-hooks.ts", import.meta.url).href;
const cliPath = new URL("./cli.ts", import.meta.url);

describe("remote resolution", () => {
  it("resolves relative dependencies against every final redirect URL", async () => {
    const result = await run(["--import", registerUrl, "--eval", `import(${JSON.stringify(`${baseUrl}/entry.mjs`)});`]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.value, "correct");
    assert.equal(output.location, `${baseUrl}/v2/child.mjs`);
    assert.equal(output.url, `${baseUrl}/v1/main.mjs`);
  });

  it("uses the redirected HTTP URL as the true CLI entry point", async () => {
    const result = await run([cliPath.pathname, `${baseUrl}/entry.mjs`]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.value, "correct");
    assert.equal(output.url, `${baseUrl}/v1/main.mjs`);
    assert.equal(output.main, true);
  });

  it("downloads each module only once between resolve and load with reload enabled", async () => {
    const result = await run(["--import", registerUrl, "--eval", `import(${JSON.stringify(`${baseUrl}/reload.mjs`)}).then(m => console.log(m.default));`], { URL_IMPORT_RELOAD: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), 42);
    assert.deepEqual(requests, ["/reload.mjs"]);
  });

  it("resolves installed npm packages from a remote parent", async () => {
    const result = await run([cliPath.pathname, `${baseUrl}/npm-parent.mjs`]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(typeof JSON.parse(result.stdout).version, "string");
    assert.deepEqual(requests, ["/npm-parent.mjs"]);
  });

  it("falls back to the selected CDN for npm packages not installed locally", async () => {
    const result = await run(["--import", registerUrl, "--eval",
      'import("npm:node-url-import-uninstalled@2/sub").then(m => console.log(m.default));'],
      { URL_IMPORT_CDN: `${baseUrl}/cdn/` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), 73);
    assert.deepEqual(requests, ["/cdn/node-url-import-uninstalled@2/sub"]);
  });

  it("loads CommonJS TypeScript with a TypeScript content type", async () => {
    const result = await run(["--import", registerUrl, "--eval", `import(${JSON.stringify(`${baseUrl}/typed.cts`)}).then(m => console.log(m.default));`]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), 17);
  });

  it("keeps CommonJS relative requires working", async () => {
    const result = await run(["--import", registerUrl, "--eval", `console.log(require(${JSON.stringify(`${baseUrl}/cjs/main.cjs`)}));`]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), 42);
  });
});
