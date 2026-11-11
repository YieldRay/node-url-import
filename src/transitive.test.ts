import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const requests: string[] = [];
const authRequests: { url: string; authorization: string | undefined }[] = [];
const targetAuthRequests: { url: string; authorization: string | undefined }[] = [];
let authTargetUrl: string;
const authTargetServer = createServer((request, response) => {
  targetAuthRequests.push({ url: request.url!, authorization: request.headers.authorization });
  if (request.headers.authorization !== "Bearer target-token") {
    response.writeHead(401).end();
    return;
  }
  response.setHeader("Content-Type", "application/javascript");
  response.end("export default 43;");
});
const server = createServer((request, response) => {
  requests.push(request.url!);
  if (request.url?.startsWith("/auth/") || request.url === "/redirect-private.mjs") {
    authRequests.push({ url: request.url, authorization: request.headers.authorization });
  }
  if (request.url === "/redirect-private.mjs") {
    if (request.headers.authorization !== "Bearer source-token") {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(302, { Location: `${authTargetUrl}/module.mjs` }).end();
    return;
  }
  const redirects: Record<string, string> = {
    "/entry.mjs": "/v1/main.mjs",
    "/v1/child.mjs": "/v2/child.mjs",
    "/cjs/redirect-main.cjs": "/cjs/v1/main.cjs",
    "/cjs/v1/redirect-child.cjs": "/cjs/v2/child.cjs",
  };
  const redirect = redirects[request.url!];
  if (redirect) {
    response.writeHead(302, { Location: redirect }).end();
    return;
  }
  response.setHeader("Content-Type", request.url?.endsWith(".cts") ? "text/typescript" :
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
    "/identity-worker.mjs?value=%23%3F": 'import { Worker } from "node:worker_threads"; const worker = new Worker(new URL(process.argv[2])); const workerEnv = await new Promise(resolve => worker.once("message", resolve)); console.log(JSON.stringify({ url: import.meta.url, main: import.meta.main, argv: process.argv.slice(2), mainEnv: process.env.URL_IMPORT_MAIN, candidatesEnv: process.env.URL_IMPORT_MAIN_CANDIDATES, workerEnv }));',
    "/identity.mjs?value=%23%3F": 'console.log(JSON.stringify({ url: import.meta.url, main: import.meta.main, argv: process.argv.slice(2) }));',
    "/cdn/node-url-import-uninstalled@2/sub": 'export default 73;',
    "/cdn/cdn-only-fixture": 'export default "cdn-fixture";',
    "/bare-parent.mjs": 'import ts from "typescript"; console.log(JSON.stringify({ version: ts.version }));',
    "/typed.cts": 'const value: number = 17; module.exports = value;',
    "/npm-parent.mjs": 'import ts from "npm:typescript@6"; console.log(JSON.stringify({ version: ts.version }));',
    "/cjs/main.cjs": 'module.exports = require("./child.cjs");',
    "/cjs/child.cjs": 'module.exports = 42;',
    "/cjs/import-parent.mjs": 'import value from "./esm-import-main.cjs"; console.log(JSON.stringify(value));',
    "/cjs/esm-import-main.cjs": 'const child = require("./esm-import-child.cjs"); const childPath = child.filename; module.exports = { filename: __filename, cacheIdentity: require.cache[__filename]?.exports === module.exports, childPath, childFilename: child.filename, childCacheIdentity: require.cache[childPath]?.exports === child, leafPath: child.leafPath, leafFilename: child.leafFilename, leafCacheIdentity: child.leafCacheIdentity, value: child.value };',
    "/cjs/esm-import-child.cjs": 'const leaf = require("./esm-import-leaf.cts"); const leafPath = leaf.filename; module.exports = { value: leaf.value, filename: __filename, cacheIdentity: require.cache[__filename]?.exports === module.exports, leafPath, leafFilename: leaf.filename, leafCacheIdentity: require.cache[leafPath]?.exports === leaf };',
    "/cjs/esm-import-leaf.cts": 'const value: number = 42; module.exports = { value, filename: __filename, cacheIdentity: require.cache[__filename]?.exports === module.exports };',
    "/cjs/cts-import-parent.mjs": 'import value from "./cts-import-main.cts"; console.log(JSON.stringify(value));',
    "/cjs/cts-import-main.cts": 'const base: number = 10; const child = require("./cts-import-child.cjs"); const typedChild = require("./cts-import-child.cts"); module.exports = { value: base + child.value + typedChild.value, mainIsMain: require.main === module, cacheIdentity: require.cache[__filename]?.exports === module.exports, childCacheIdentity: require.cache[child.filename]?.exports === child, typedChildCacheIdentity: require.cache[typedChild.filename]?.exports === typedChild };',
    "/cjs/cts-import-child.cjs": 'module.exports = { value: 20, filename: __filename };',
    "/cjs/cts-import-child.cts": 'const value: number = 12; module.exports = { value, filename: __filename };',
    "/cjs/cts-cli-main.cts": 'const base: number = 10; const child = require("./cts-import-child.cjs"); const typedChild = require("./cts-import-child.cts"); console.log(JSON.stringify({ value: base + child.value + typedChild.value, isMain: require.main === module, cacheIdentity: require.cache[__filename]?.exports === module.exports, childCacheIdentity: require.cache[child.filename]?.exports === child, typedChildCacheIdentity: require.cache[typedChild.filename]?.exports === typedChild }));',
    "/cjs/cli-main.cjs": 'const child = require("./child.cjs"); console.log(child);',
    "/cjs/identity-main.cjs?variant=1": 'globalThis.cliMainExecutions = (globalThis.cliMainExecutions ?? 0) + 1; exports.ready = true; const self = require("./identity-main.cjs?variant=1#fragment"); const child = require("./identity-child.cjs"); console.log(JSON.stringify({ isMain: require.main === module, moduleLoaded: module.loaded, selfExports: self === module.exports, childSawExports: child.mainExports.ready, executions: globalThis.cliMainExecutions, argv: process.argv.slice(2) }));',
    "/cjs/identity-child.cjs": 'const main = require("./identity-main.cjs?variant=1#fragment"); module.exports = { mainExports: main };',
    "/cjs/v1/main.cjs": 'const child = require("./redirect-child.cjs"); console.log(child);',
    "/cjs/v2/child.cjs": 'module.exports = require("./leaf.cjs");',
    "/cjs/v2/leaf.cjs": 'module.exports = "redirected-child";',
    "/auth/esm.mjs": 'import value from "./dependency.mjs"; console.log(value);',
    "/auth/dependency.mjs": "export default 42;",
    "/auth/cjs.cjs": 'module.exports = require("./dependency.cjs");',
    "/auth/dependency.cjs": "module.exports = 42;",
  };
  const expectedAuthorization: Record<string, string[]> = {
    "/auth/esm.mjs": ["Bearer sync-token", "Bearer async-token"],
    "/auth/dependency.mjs": ["Bearer sync-token", "Bearer async-token"],
    "/auth/cjs.cjs": ["Basic dXNlcjpwYXNzd29yZA=="],
    "/auth/dependency.cjs": ["Basic dXNlcjpwYXNzd29yZA=="],
  };
  if (request.url && request.url in expectedAuthorization &&
    !expectedAuthorization[request.url]!.includes(request.headers.authorization ?? "")) {
    response.writeHead(401).end();
    return;
  }
  response.end(sources[request.url!] ?? 'throw new Error("Unexpected module");');
});
let baseUrl: string;
let workspace: string;

before(async () => {
  await new Promise<void>((resolve) => authTargetServer.listen(0, "127.0.0.1", resolve));
  const targetAddress = authTargetServer.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  authTargetUrl = `http://127.0.0.1:${targetAddress.port}`;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  authTargetServer.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => authTargetServer.close(() => resolve())),
  ]);
});
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "node-url-import-resolve-test-"));
  requests.length = 0;
  authRequests.length = 0;
  targetAuthRequests.length = 0;
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
  it("sends DENO_AUTH_TOKENS credentials for CLI ESM imports and CommonJS requires", async () => {
    const host = new URL(baseUrl).host;
    const result = await run([cliPath, `${baseUrl}/auth/esm.mjs`], {
      DENO_AUTH_TOKENS: `sync-token@${host}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "42");
    assert.deepEqual(authRequests, [
      { url: "/auth/esm.mjs", authorization: "Bearer sync-token" },
      { url: "/auth/dependency.mjs", authorization: "Bearer sync-token" },
    ]);

    authRequests.length = 0;
    const cjs = await run([cliPath, "--eval", `console.log(require(${JSON.stringify(`${baseUrl}/auth/cjs.cjs`)}));`], {
      DENO_AUTH_TOKENS: `user:password@${host}`,
    });
    assert.equal(cjs.status, 0, cjs.stderr);
    assert.equal(cjs.stdout.trim(), "42");
    assert.deepEqual(authRequests, [
      { url: "/auth/cjs.cjs", authorization: "Basic dXNlcjpwYXNzd29yZA==" },
      { url: "/auth/dependency.cjs", authorization: "Basic dXNlcjpwYXNzd29yZA==" },
    ]);
  });

  it("keeps the preload DENO_AUTH_TOKENS value for the sync fetch worker", async () => {
    const host = new URL(baseUrl).host;
    const result = await run(["--import", registerUrl, "--input-type=module", "--eval", `
      process.env.DENO_AUTH_TOKENS = ${JSON.stringify(`late-token@${host}`)};
      await import(${JSON.stringify(`${baseUrl}/auth/esm.mjs`)});
    `], { DENO_AUTH_TOKENS: `sync-token@${host}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "42");
    assert.deepEqual(authRequests, [
      { url: "/auth/esm.mjs", authorization: "Bearer sync-token" },
      { url: "/auth/dependency.mjs", authorization: "Bearer sync-token" },
    ]);
  });

  it("sends DENO_AUTH_TOKENS credentials through the asynchronous loader", async () => {
    const host = new URL(baseUrl).host;
    const loaderUrl = new URL("./loader.ts", import.meta.url).href;
    const result = await run(["--input-type=module", "--eval", `
      import { register } from "node:module";
      register(${JSON.stringify(loaderUrl)}, import.meta.url);
      await import(${JSON.stringify(`${baseUrl}/auth/esm.mjs`)});
    `], { DENO_AUTH_TOKENS: `async-token@${host}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "42");
    assert.deepEqual(authRequests, [
      { url: "/auth/esm.mjs", authorization: "Bearer async-token" },
      { url: "/auth/dependency.mjs", authorization: "Bearer async-token" },
    ]);
  });

  it("selects credentials again after a cross-port redirect and does not leak them", async () => {
    const sourceHost = new URL(baseUrl).host;
    const targetHost = new URL(authTargetUrl).host;
    const loaderUrl = new URL("./loader.ts", import.meta.url).href;
    for (const mode of ["sync", "async"] as const) {
      authRequests.length = 0;
      targetAuthRequests.length = 0;
      const registration = mode === "sync"
        ? `import ${JSON.stringify(registerUrl)};`
        : `import { register } from "node:module"; register(${JSON.stringify(loaderUrl)}, import.meta.url);`;
      const loadRedirect = `
        ${registration}
        const module = await import(${JSON.stringify(`${baseUrl}/redirect-private.mjs`)});
        console.log(module.default);
      `;

      const withoutTargetCredential = await run(["--input-type=module", "--eval", loadRedirect], {
        DENO_AUTH_TOKENS: `source-token@${sourceHost}`,
        URL_IMPORT_RELOAD: "1",
      });
      assert.equal(withoutTargetCredential.status, 1, `${mode} hooks must reject the private target without its token`);
      assert.deepEqual(authRequests, [
        { url: "/redirect-private.mjs", authorization: "Bearer source-token" },
      ]);
      assert.deepEqual(targetAuthRequests, [{ url: "/module.mjs", authorization: undefined }]);
      assert.match(withoutTargetCredential.stderr, /401/);

      authRequests.length = 0;
      targetAuthRequests.length = 0;
      const withTargetCredential = await run(["--input-type=module", "--eval", loadRedirect], {
        DENO_AUTH_TOKENS: `source-token@${sourceHost};target-token@${targetHost}`,
        URL_IMPORT_RELOAD: "1",
      });
      assert.equal(withTargetCredential.status, 0, withTargetCredential.stderr);
      assert.equal(withTargetCredential.stdout.trim(), "43");
      assert.doesNotMatch(withTargetCredential.stderr, /source-token|target-token/);
      assert.deepEqual(authRequests, [
        { url: "/redirect-private.mjs", authorization: "Bearer source-token" },
      ]);
      assert.deepEqual(targetAuthRequests, [{ url: "/module.mjs", authorization: "Bearer target-token" }]);
    }
  });

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

  it("consumes a direct URL_IMPORT_MAIN and does not pass it to a Worker", async () => {
    const target = `${baseUrl}/identity-worker.mjs?value=%23%3F#identity`;
    const workerPath = join(workspace, "env-worker.mjs");
    writeFileSync(workerPath, 'import { parentPort } from "node:worker_threads"; parentPort.postMessage(JSON.stringify({ main: process.env.URL_IMPORT_MAIN, candidates: process.env.URL_IMPORT_MAIN_CANDIDATES }));');
    const result = await run(["--import", registerUrl, target, pathToFileURL(workerPath).href], {
      URL_IMPORT_MAIN: target,
      URL_IMPORT_MAIN_CANDIDATES: "{}",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.url, target);
    assert.equal(output.main, true);
    assert.deepEqual(output.argv, [pathToFileURL(workerPath).href]);
    assert.equal(output.mainEnv, undefined);
    assert.equal(output.candidatesEnv, undefined);
    assert.deepEqual(JSON.parse(output.workerEnv), {});
    assert.deepEqual(requests, ["/identity-worker.mjs?value=%23%3F"]);
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

  it("loads ESM-imported CommonJS chains from real cached paths, including .cts", async () => {
    const result = await run(["--import", registerUrl, "--eval", `import(${JSON.stringify(`${baseUrl}/cjs/import-parent.mjs`)});`], {
      URL_IMPORT_TMP: "0",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.cacheIdentity, true);
    assert.equal(output.childCacheIdentity, true);
    assert.equal(output.leafCacheIdentity, true);
    assert.equal(output.childPath, output.childFilename);
    assert.equal(output.leafPath, output.leafFilename);
    assert.equal(output.value, 42);
    for (const filename of [output.filename, output.childFilename, output.leafFilename]) {
      assert.ok(filename.includes("/node-url-import/session-"), filename);
      assert.ok(existsSync(filename), filename);
    }
    assert.match(output.filename, /\.cjs$/);
    assert.match(output.childFilename, /\.cjs$/);
    assert.match(output.leafFilename, /\.cts$/);
    assert.deepEqual(requests, [
      "/cjs/import-parent.mjs",
      "/cjs/esm-import-main.cjs",
      "/cjs/esm-import-child.cjs",
      "/cjs/esm-import-leaf.cts",
    ]);
  });

  it("loads relative CJS and CTS dependencies from an ESM-imported remote CTS module", async () => {
    for (const tmp of ["0", "1"]) {
      requests.length = 0;
      const result = await run(["--import", registerUrl, "--eval", `import(${JSON.stringify(`${baseUrl}/cjs/cts-import-parent.mjs`)});`], {
        URL_IMPORT_TMP: tmp,
        DENO_DIR: join(workspace, `deno-cts-import-${tmp}`),
      });
      assert.equal(result.status, 0, `URL_IMPORT_TMP=${tmp}\n${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), {
        value: 42,
        mainIsMain: false,
        cacheIdentity: true,
        childCacheIdentity: true,
        typedChildCacheIdentity: true,
      });
      assert.deepEqual(requests, [
        "/cjs/cts-import-parent.mjs",
        "/cjs/cts-import-main.cts",
        "/cjs/cts-import-child.cjs",
        "/cjs/cts-import-child.cts",
      ]);
    }
  });

  it("runs a remote CTS CLI main with relative CJS and CTS requires", async () => {
    for (const tmp of ["0", "1"]) {
      requests.length = 0;
      const result = await run([cliPath, `${baseUrl}/cjs/cts-cli-main.cts`], {
        URL_IMPORT_TMP: tmp,
        DENO_DIR: join(workspace, `deno-cts-cli-${tmp}`),
      });
      assert.equal(result.status, 0, `URL_IMPORT_TMP=${tmp}\n${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), {
        value: 42,
        isMain: true,
        cacheIdentity: true,
        childCacheIdentity: true,
        typedChildCacheIdentity: true,
      });
      assert.deepEqual(requests, [
        "/cjs/cts-cli-main.cts",
        "/cjs/cts-import-child.cjs",
        "/cjs/cts-import-child.cts",
      ]);
    }
  });

  it("runs a remote CommonJS CLI main with relative requires", async () => {
    const results = [];
    for (const tmp of ["0", "1"]) {
      requests.length = 0;
      const result = await run([cliPath, "--reload", `${baseUrl}/cjs/cli-main.cjs`], {
        URL_IMPORT_TMP: tmp,
        DENO_DIR: join(workspace, `deno-cjs-${tmp}`),
      });
      results.push({ tmp, result, requests: [...requests] });
    }
    for (const { tmp, result, requests: requested } of results) {
      assert.equal(result.status, 0, `URL_IMPORT_TMP=${tmp}\n${result.stderr}`);
      assert.equal(result.stdout.trim(), "42");
      assert.deepEqual(requested, ["/cjs/cli-main.cjs", "/cjs/child.cjs"]);
    }
  });

  it("preserves CommonJS main identity, query, fragment and CLI arguments", async () => {
    const remoteLookingTitle = `${baseUrl}/not-the-main.mjs`;
    const target = `${baseUrl}/cjs/identity-main.cjs?variant=1#fragment`;
    const result = await run([
      cliPath,
      `--title=${remoteLookingTitle}`,
      "--",
      target,
      "argument",
      "--reload",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      isMain: true,
      moduleLoaded: false,
      selfExports: true,
      childSawExports: true,
      executions: 1,
      argv: ["argument", "--reload"],
    });
    assert.deepEqual(requests, [
      "/cjs/identity-main.cjs?variant=1",
      "/cjs/identity-child.cjs",
    ]);
  });

  it("resolves CommonJS CLI main and transitive require bases after redirects", async () => {
    const result = await run([cliPath, `${baseUrl}/cjs/redirect-main.cjs`]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "redirected-child");
    assert.deepEqual(requests, [
      "/cjs/redirect-main.cjs",
      "/cjs/v1/main.cjs",
      "/cjs/v1/redirect-child.cjs",
      "/cjs/v2/child.cjs",
      "/cjs/v2/leaf.cjs",
    ]);
  });
});
