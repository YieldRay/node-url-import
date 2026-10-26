import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  response.setHeader("Content-Type", request.url === "/typed.cts" ? "text/typescript" :
    request.url === "/data.json" ? "application/json" : "application/javascript");
  const sources: Record<string, string> = {
    "/v1/main.mjs": 'import { value, location } from "./child.mjs"; console.log(JSON.stringify({ value, location, main: import.meta.main, url: import.meta.url }));',
    "/v2/child.mjs": 'export { default as value } from "./dep.mjs"; export const location = import.meta.url;',
    "/v2/dep.mjs": 'export default "correct";',
    "/v1/dep.mjs": 'export default "wrong";',
    "/reload.mjs": 'export default 42;',
    "/data.json": '{"answer":42}',
    "/json-code.mjs": 'globalThis.executedAsCode = true; export default 42;',
    "/worker-main.mjs": 'import { Worker, isMainThread, parentPort } from "node:worker_threads"; if (isMainThread) { const worker = new Worker(new URL(process.argv[2])); worker.on("message", message => console.log(message)); } else { parentPort.postMessage("wrong-remote-worker"); }',
    "/identity.mjs?value=%23%3F": 'console.log(JSON.stringify({ url: import.meta.url, main: import.meta.main, argv: process.argv.slice(2) }));',
    "/cdn/node-url-import-uninstalled@2/sub": 'export default 73;',
    "/cdn/cdn-only-fixture": 'export default "cdn-fixture";',
    "/bare-parent.mjs": 'import ts from "typescript"; console.log(JSON.stringify({ version: ts.version }));',
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
      env: { ...process.env, FORCE_COLOR: "0", DENO_DIR: join(workspace, "deno"), TMPDIR: workspace, ...extraEnv },
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
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

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
    const result = await run([cliPath, `${baseUrl}/entry.mjs`]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.value, "correct");
    assert.equal(output.url, `${baseUrl}/v1/main.mjs`);
    assert.equal(output.main, true);
  });

  it("lets Node select a remote entry after its own valued flags", async () => {
    const result = await run([cliPath, "--reload", "--title", "cli-title", `${baseUrl}/entry.mjs#identity`]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.value, "correct");
    assert.equal(output.url, `${baseUrl}/v1/main.mjs`);
    assert.equal(output.main, true);
  });

  it("preserves a remote entry's exact query, fragment, and arguments after --", async () => {
    const target = `${baseUrl}/identity.mjs?value=%23%3F#identity`;
    const scriptArgs = ["--reload", "--clear-cache", `${baseUrl}/not-main.mjs`];
    const result = await run([cliPath, "--", target, ...scriptArgs]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.url, target);
    assert.equal(output.main, true);
    assert.deepEqual(output.argv, scriptArgs);
    assert.deepEqual(requests, ["/identity.mjs?value=%23%3F"]);
  });

  it("does not mistake an HTTP-valued Node option for the remote entry", async () => {
    const result = await run([cliPath, "--title", `${baseUrl}/not-main.mjs`, `${baseUrl}/entry.mjs`]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.url, `${baseUrl}/v1/main.mjs`);
    assert.equal(output.main, true);
    assert.ok(!requests.includes("/not-main.mjs"));
  });

  it("leaves HTTP arguments in eval mode untouched without selecting a remote main", async () => {
    const target = `${baseUrl}/entry.mjs`;
    const result = await run([cliPath, "--eval", 'console.log(JSON.stringify({ argv: process.argv.slice(1), main: process.env.URL_IMPORT_MAIN }));', "--", target]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.argv, [target]);
    assert.equal(output.main, undefined);
    assert.deepEqual(requests, []);
  });

  it("downloads each module only once between resolve and load with reload enabled", async () => {
    const result = await run(["--import", registerUrl, "--eval", `import(${JSON.stringify(`${baseUrl}/reload.mjs`)}).then(m => console.log(m.default));`], { URL_IMPORT_RELOAD: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), 42);
    assert.deepEqual(requests, ["/reload.mjs"]);
  });

  it("resolves installed npm packages from a remote parent", async () => {
    const result = await run([cliPath, `${baseUrl}/npm-parent.mjs`]);
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

  it("uses one canonical module identity for cached equivalent URLs", async () => {
    for (const tmp of ["0", "1"]) {
      const result = await run(["--import", registerUrl, "--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        const { writeCache } = await import(${JSON.stringify(new URL("./cache.ts", import.meta.url).href)});
        const url = "https://canonical.test/mod.mjs?q=1#identity";
        writeCache([url], "export default {};", "application/javascript");
        const first = await import(url);
        for (const variant of ["https://CANONICAL.test:443/mod.mjs?q=1#identity", "HTTPS://canonical.test/mod.mjs?q=1#identity", "https://canonical.test/dir/../mod.mjs?q=1#identity"]) {
          assert.equal(await import(variant), first);
        }
      `], { URL_IMPORT_TMP: tmp });
      assert.equal(result.status, 0, result.stderr);
    }
  });

  it("does not redirect local Worker entries to the remote CLI main", async () => {
    const workerPath = join(workspace, "worker.mjs");
    writeFileSync(workerPath, 'import { parentPort } from "node:worker_threads"; parentPort.postMessage("local-worker");');
    for (const tmp of ["0", "1"]) {
      const result = await run([cliPath, `${baseUrl}/worker-main.mjs`, pathToFileURL(workerPath).href], { URL_IMPORT_TMP: tmp });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "local-worker");
    }
  });

  it("keeps package #imports local with a CDN enabled", async () => {
    const packagePath = join(workspace, "package");
    mkdirSync(packagePath);
    writeFileSync(join(packagePath, "package.json"), JSON.stringify({ type: "module", imports: { "#answer": "./answer.mjs" } }));
    writeFileSync(join(packagePath, "answer.mjs"), "export default 42;");
    const entryPath = join(packagePath, "main.mjs");
    writeFileSync(entryPath, 'import answer from "#answer"; console.log(answer);');
    const result = await run([cliPath, `--cdn=${baseUrl}/cdn/`, entryPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "42");
    assert.deepEqual(requests, []);
  });

  it("resolves bare packages from node_modules before the CDN", async () => {
    const packagePath = join(workspace, "package");
    mkdirSync(join(packagePath, "node_modules", "installed-fixture"), { recursive: true });
    writeFileSync(join(packagePath, "node_modules", "installed-fixture", "package.json"),
      JSON.stringify({ name: "installed-fixture", type: "module", exports: { ".": "./main.mjs" } }));
    writeFileSync(join(packagePath, "node_modules", "installed-fixture", "main.mjs"), 'export default "local";');
    const entryPath = join(packagePath, "main.mjs");
    writeFileSync(entryPath, 'import local from "installed-fixture"; import remote from "cdn-only-fixture"; console.log(JSON.stringify({ local, remote }));');
    const result = await run([cliPath, `--cdn=${baseUrl}/cdn/`, entryPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { local: "local", remote: "cdn-fixture" });
    assert.deepEqual(requests, ["/cdn/cdn-only-fixture"]);
  });

  it("lets remote modules use locally installed bare packages with a CDN enabled", async () => {
    const result = await run(["--import", registerUrl, "--eval", `import(${JSON.stringify(`${baseUrl}/bare-parent.mjs`)});`],
      { URL_IMPORT_CDN: `${baseUrl}/cdn/` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(typeof JSON.parse(result.stdout).version, "string");
    assert.deepEqual(requests, ["/bare-parent.mjs"]);
  });

  it("enforces JSON import attributes without executing JavaScript as data", async () => {
    for (const tmp of ["0", "1"]) {
      const result = await run(["--import", registerUrl, "--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        const url = ${JSON.stringify(`${baseUrl}/data.json`)};
        await assert.rejects(import(url));
        await assert.rejects(import(url, { with: { type: "javascript" } }));
        await assert.rejects(import(url, { with: { extra: "unsupported", type: "json" } }));
        assert.equal((await import(url, { with: { type: "json" } })).default.answer, 42);
        await assert.rejects(import(${JSON.stringify(`${baseUrl}/json-code.mjs`)}, { with: { type: "json" } }));
        assert.equal(globalThis.executedAsCode, undefined);
      `], { URL_IMPORT_TMP: tmp });
      assert.equal(result.status, 0, result.stderr);
    }
  });

  it("distinguishes native require(JSON) from user-supplied require conditions", async () => {
    const url = `${baseUrl}/data.json`;
    for (const tmp of ["0", "1"]) {
      const esm = await run(["--import", registerUrl, "--conditions=require", "--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        await assert.rejects(import(${JSON.stringify(url)}));
        assert.equal((await import(${JSON.stringify(url)}, { with: { type: "json" } })).default.answer, 42);
      `], { URL_IMPORT_TMP: tmp });
      assert.equal(esm.status, 0, esm.stderr);
      const cjs = await run(["--import", registerUrl, "--conditions=import", "--eval", `console.log(require(${JSON.stringify(url)}).answer);`], { URL_IMPORT_TMP: tmp });
      assert.equal(cjs.status, 0, cjs.stderr);
      assert.equal(cjs.stdout.trim(), "42");
    }
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
