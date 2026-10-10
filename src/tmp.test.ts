import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { urlToTmpPath, tmpPathToUrl, writeTmpFile } from "./tmp.ts";

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/javascript");
  const sources: Record<string, string> = {
    "/pkg": 'export { default } from "./dep.mjs";',
    "/dep.mjs": 'export default "correct";',
    "/pkg/dep.mjs": 'export default "wrong";',
    "/pkg/index.mjs": 'export default "index";',
    "/npm.mjs": 'import ts from "npm:typescript"; console.log(JSON.stringify({ version: ts.version, url: import.meta.url, main: import.meta.main }));',
    "/bare.mjs": 'import ts from "typescript"; export default ts.version;',
    "/main.cjs": 'module.exports = require("./dep.cjs");',
    "/dep.cjs": 'module.exports = 42;',
  };
  response.end(sources[request.url!] ?? `export default ${JSON.stringify(request.url)};`);
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
beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "node-url-import-tmp-test-")); });
afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, DENO_DIR: join(workspace, "deno"), TMPDIR: workspace, URL_IMPORT_TMP: "1", ...extraEnv },
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

describe("tmp URL identity", () => {
  it("roundtrips exact URLs including directory, query and fragment semantics", () => {
    const urls = [
      "https://modules.test/", "https://modules.test/pkg", "https://modules.test/pkg/",
      "https://modules.test/pkg/index.mjs", "https://modules.test/variant.mjs?target=node",
      "https://modules.test/variant.mjs?target=es2022", "https://modules.test/variant.mjs#first",
      "https://modules.test/variant.mjs#second", "http://localhost:8080/a%20b/mod.mts",
    ];
    const paths = urls.map((url) => urlToTmpPath(url, "application/javascript"));
    assert.equal(new Set(paths).size, urls.length);
    for (let index = 0; index < urls.length; index++) {
      assert.equal(tmpPathToUrl(paths[index]!), urls[index]);
      assert.equal(tmpPathToUrl(pathToFileURL(paths[index]!).href), urls[index]);
    }
  });

  it("uses native extensions for TypeScript, JSON and binary modules", () => {
    for (const [url, type, extension] of [
      ["https://modules.test/types", "text/typescript", ".ts"],
      ["https://modules.test/json", "application/json", ".json"],
      ["https://modules.test/wasm", "application/wasm", ".wasm"],
      ["https://modules.test/main.cts", "text/typescript", ".cts"],
    ]) {
      assert.equal(extname(urlToTmpPath(url!, type!)), extension);
    }
  });

  it("can map a module URL and a descendant without file-directory collisions", () => {
    const parent = urlToTmpPath("https://modules.test/folder.mjs");
    const child = urlToTmpPath("https://modules.test/folder.mjs/child.mjs");
    writeTmpFile(parent, "export default 1;");
    writeTmpFile(child, "export default 2;");
    assert.equal(readFileSync(parent, "utf8"), "export default 1;");
    assert.equal(readFileSync(child, "utf8"), "export default 2;");
  });

  it("does not interpret unregistered local files as remote modules", () => {
    assert.equal(tmpPathToUrl(join(workspace, "https", "modules.test", "mod.mjs")), null);
    assert.equal(tmpPathToUrl("file:///unrelated/mod.mjs"), null);
  });

  it("writes text and binary modules without changing their bytes", () => {
    const textPath = join(workspace, "nested", "module.mjs");
    const binaryPath = join(workspace, "nested", "module.wasm");
    const bytes = Uint8Array.from([0, 128, 255]);
    writeTmpFile(textPath, "export default 42;");
    writeTmpFile(binaryPath, bytes);
    assert.equal(readFileSync(textPath, "utf8"), "export default 42;");
    assert.deepEqual([...readFileSync(binaryPath)], [...bytes]);
  });
});

describe("tmp module loading", () => {
  it("preserves extensionless relative import bases", async () => {
    const result = await run(["--import", registerUrl, "--eval", `import(${JSON.stringify(`${baseUrl}/pkg`)}).then(m => console.log(m.default));`]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "correct");
  });

  it("does not merge query, fragment or synthetic index module identities", async () => {
    const urls = ["/variant.mjs?q=1", "/variant.mjs?q=2", "/pkg", "/pkg/index.mjs"].map((path) => baseUrl + path);
    const result = await run(["--import", registerUrl, "--eval", `
      (async () => {
        const values = [];
        for (const url of ${JSON.stringify(urls)}) values.push((await import(url)).default);
        const first = await import(${JSON.stringify(`${baseUrl}/variant.mjs#first`)});
        const second = await import(${JSON.stringify(`${baseUrl}/variant.mjs#second`)});
        console.log(JSON.stringify({ values, separate: first !== second }));
      })();
    `], { URL_IMPORT_RELOAD: "1" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.values, ["/variant.mjs?q=1", "/variant.mjs?q=2", "correct", "index"]);
    assert.equal(output.separate, true);
  });

  it("writes the actual CLI main module to a local temporary file", async () => {
    const result = await run([fileURLToPath(new URL("./cli.ts", import.meta.url)), "--tmp", `${baseUrl}/npm.mjs`]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(typeof output.version, "string");
    assert.equal(output.main, true);
    assert.ok(output.url.startsWith("file:"));
    assert.ok(existsSync(fileURLToPath(output.url)));
  });

  it("resolves local bare packages from the project rather than the tmp directory", async () => {
    const result = await run(["--import", registerUrl, "--eval", `import(${JSON.stringify(`${baseUrl}/bare.mjs`)}).then(m => console.log(JSON.stringify(m.default)));`]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(typeof JSON.parse(result.stdout), "string");
  });

  it("supports CommonJS relative requires", async () => {
    const result = await run(["--import", registerUrl, "--eval", `console.log(require(${JSON.stringify(`${baseUrl}/main.cjs`)}));`]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), 42);
  });
});
