import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { urlToTmpPath, tmpPathToUrl, writeTmpFile } from "./tmp.ts";

const TMP_ROOT = join(tmpdir(), "node-url-import");

describe("tmp: urlToTmpPath", () => {
  it("should map https URL with extension to tmp path", () => {
    const result = urlToTmpPath(
      "https://esm.sh/v135/pkg@1.0.0/script.js",
      "application/javascript",
    );
    assert.equal(
      result,
      join(TMP_ROOT, "https", "esm.sh", "v135", "pkg@1.0.0", "script.js"),
    );
  });

  it("should map http URL with extension to tmp path", () => {
    const result = urlToTmpPath(
      "http://example.com/lib/index.mjs",
      "application/javascript",
    );
    assert.equal(
      result,
      join(TMP_ROOT, "http", "example.com", "lib", "index.mjs"),
    );
  });

  it("should handle URL with nested path", () => {
    const result = urlToTmpPath(
      "https://cdn.example.com/a/b/c/d.js",
      "application/javascript",
    );
    assert.equal(
      result,
      join(TMP_ROOT, "https", "cdn.example.com", "a", "b", "c", "d.js"),
    );
  });

  it("should handle URL with port", () => {
    const result = urlToTmpPath(
      "https://localhost:3000/script.js",
      "application/javascript",
    );
    assert.equal(
      result,
      join(TMP_ROOT, "https", "localhost:3000", "script.js"),
    );
  });

  it("should append index.mjs for extensionless JS URL", () => {
    const result = urlToTmpPath(
      "https://esm.sh/ms@2.1.3",
      "application/javascript",
    );
    assert.equal(
      result,
      join(TMP_ROOT, "https", "esm.sh", "ms@2.1.3", "index.mjs"),
    );
  });

  it("should append index.ts for TypeScript content type", () => {
    const result = urlToTmpPath(
      "https://deno.land/x/mod@1.0.0",
      "text/typescript",
    );
    assert.equal(
      result,
      join(TMP_ROOT, "https", "deno.land", "x", "mod@1.0.0", "index.ts"),
    );
  });

  it("should append index.json for JSON content type", () => {
    const result = urlToTmpPath(
      "https://api.example.com/config",
      "application/json",
    );
    assert.equal(
      result,
      join(TMP_ROOT, "https", "api.example.com", "config", "index.json"),
    );
  });

  it("should append index.mjs when no content type provided", () => {
    const result = urlToTmpPath("https://esm.sh/pkg@1.0.0");
    assert.equal(
      result,
      join(TMP_ROOT, "https", "esm.sh", "pkg@1.0.0", "index.mjs"),
    );
  });

  it("should preserve real /index.mjs in URL path", () => {
    const result = urlToTmpPath(
      "https://cdn.example.com/lib/index.mjs",
      "application/javascript",
    );
    assert.equal(
      result,
      join(TMP_ROOT, "https", "cdn.example.com", "lib", "index.mjs"),
    );
  });

  it("should preserve .ts extension without adding index", () => {
    const result = urlToTmpPath(
      "https://deno.land/x/mod@1.0.0/main.ts",
      "text/typescript",
    );
    assert.equal(
      result,
      join(TMP_ROOT, "https", "deno.land", "x", "mod@1.0.0", "main.ts"),
    );
  });
});

describe("tmp: tmpPathToUrl", () => {
  it("should reverse-map tmp path with extension to https URL", () => {
    const tmpPath = join(
      TMP_ROOT,
      "https",
      "esm.sh",
      "v135",
      "pkg@1.0.0",
      "script.js",
    );
    const result = tmpPathToUrl(tmpPath);
    assert.equal(result, "https://esm.sh/v135/pkg@1.0.0/script.js");
  });

  it("should reverse-map file:// URL to https URL", () => {
    const fileUrl = `file://${join(TMP_ROOT, "https", "esm.sh", "pkg", "index.mjs")}`;
    const result = tmpPathToUrl(fileUrl);
    // index.mjs is NOT stripped — returned URL includes it
    assert.equal(result, "https://esm.sh/pkg/index.mjs");
  });

  it("should reverse-map http scheme", () => {
    const tmpPath = join(TMP_ROOT, "http", "example.com", "lib.js");
    const result = tmpPathToUrl(tmpPath);
    assert.equal(result, "http://example.com/lib.js");
  });

  it("should return null for path outside tmp root", () => {
    const result = tmpPathToUrl("/some/other/path/file.js");
    assert.equal(result, null);
  });

  it("should return null for malformed path under tmp root (no host)", () => {
    const result = tmpPathToUrl(join(TMP_ROOT, "https"));
    assert.equal(result, null);
  });

  it("should preserve index.mjs in reverse mapping (no stripping)", () => {
    const tmpPath = join(
      TMP_ROOT,
      "https",
      "esm.sh",
      "ms@2.1.3",
      "index.mjs",
    );
    const result = tmpPathToUrl(tmpPath);
    // Not stripped — relative imports resolve against same base directory
    assert.equal(result, "https://esm.sh/ms@2.1.3/index.mjs");
  });

  it("should preserve real /index.mjs from URL path", () => {
    const tmpPath = join(
      TMP_ROOT,
      "https",
      "cdn.example.com",
      "lib",
      "index.mjs",
    );
    const result = tmpPathToUrl(tmpPath);
    assert.equal(result, "https://cdn.example.com/lib/index.mjs");
  });

  it("should roundtrip: urlToTmpPath → tmpPathToUrl for URL with extension", () => {
    const original = "https://esm.sh/v135/lodash-es@4.17.21/es2022/add.js";
    const tmpPath = urlToTmpPath(original, "application/javascript");
    const recovered = tmpPathToUrl(tmpPath);
    assert.equal(recovered, original);
  });

  it("should roundtrip correctly for extensionless URL (includes index.mjs)", () => {
    const original = "https://esm.sh/ms@2.1.3";
    const tmpPath = urlToTmpPath(original, "application/javascript");
    const recovered = tmpPathToUrl(tmpPath);
    // Recovered URL includes /index.mjs — this is fine because
    // relative imports resolve against the same base directory
    assert.equal(recovered, "https://esm.sh/ms@2.1.3/index.mjs");

    // Verify: relative import resolves the same from both URLs
    const fromOriginal = new URL("./es2022/ms.mjs", original + "/").href;
    const fromRecovered = new URL("./es2022/ms.mjs", recovered).href;
    assert.equal(fromOriginal, fromRecovered);
  });
});

describe("tmp: writeTmpFile", () => {
  const testDir = join(TMP_ROOT, "__test__", "write-test");
  const testPath = join(testDir, "file.js");

  afterEach(async () => {
    await rm(join(TMP_ROOT, "__test__"), { recursive: true, force: true });
  });

  it("should write file and create parent directories", async () => {
    await writeTmpFile(testPath, "export default 42;\n");
    assert.ok(existsSync(testPath));
    const content = await readFile(testPath, "utf-8");
    assert.equal(content, "export default 42;\n");
  });
});

describe("tmp: CLI --tmp smoke test", () => {
  const fixtureDir = join(tmpdir(), "node-url-import-test-fixtures");

  afterEach(async () => {
    await rm(join(TMP_ROOT, "https", "esm.sh"), {
      recursive: true,
      force: true,
    });
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("should write fetched module to tmp dir and execute successfully", async () => {
    await mkdir(fixtureDir, { recursive: true });
    const scriptPath = join(fixtureDir, "smoke-ms.mjs");
    await writeFile(
      scriptPath,
      `import ms from "https://esm.sh/ms@2.1.3";\nconsole.log(ms(60000));\n`,
      "utf-8",
    );

    const result = spawnSync(
      process.execPath,
      ["src/cli.ts", "--tmp", scriptPath],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        encoding: "utf-8",
        timeout: 30_000,
      },
    );

    assert.equal(
      result.status,
      0,
      `CLI exited with ${result.status}\nstderr: ${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes("1m"),
      `Expected "1m" in stdout, got: ${result.stdout}`,
    );

    const tmpHttpsDir = join(TMP_ROOT, "https", "esm.sh");
    assert.ok(
      existsSync(tmpHttpsDir),
      `Expected tmp dir to exist: ${tmpHttpsDir}`,
    );
  });

  it("should write transitive deps to tmp dir", async () => {
    await mkdir(fixtureDir, { recursive: true });
    const scriptPath = join(fixtureDir, "smoke-lodash.mjs");
    await writeFile(
      scriptPath,
      `import { add } from "https://esm.sh/lodash-es@4.17.21";\nconsole.log(add(2, 3));\n`,
      "utf-8",
    );

    const result = spawnSync(
      process.execPath,
      ["src/cli.ts", "--tmp", scriptPath],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        encoding: "utf-8",
        timeout: 30_000,
      },
    );

    assert.equal(
      result.status,
      0,
      `CLI exited with ${result.status}\nstderr: ${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes("5"),
      `Expected "5" in stdout, got: ${result.stdout}`,
    );

    const tmpHttpsDir = join(TMP_ROOT, "https", "esm.sh");
    assert.ok(
      existsSync(tmpHttpsDir),
      `Expected tmp dir to exist: ${tmpHttpsDir}`,
    );
  });
});
