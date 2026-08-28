import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ResolveHookContext } from "node:module";
import { isEsmShCdn, jsrToCdnUrl, parseJsrSpecifier } from "./jsr.ts";
import { resolve } from "./hooks.ts";

describe("parseJsrSpecifier", () => {
  it("accepts valid specifiers", () => {
    parseJsrSpecifier("jsr:@std/uuid");
    parseJsrSpecifier("jsr:@std/uuid@1.0.1");
    parseJsrSpecifier("jsr:@std/uuid/v1");
    parseJsrSpecifier("jsr:@std/uuid@1.0.1/v1");
    parseJsrSpecifier("jsr:@hono/hono@4");
    parseJsrSpecifier("jsr:@std/http/file-server");
  });

  it("throws on invalid specifiers", () => {
    assert.throws(() => parseJsrSpecifier("jsr:uuid"), /Invalid JSR specifier/);
    assert.throws(() => parseJsrSpecifier("jsr:@std"), /Invalid JSR specifier/);
    assert.throws(
      () => parseJsrSpecifier("jsr:@Std/uuid"),
      /Invalid JSR specifier/,
    );
  });
});

describe("isEsmShCdn", () => {
  it("matches esm.sh base URLs", () => {
    assert.ok(isEsmShCdn("https://esm.sh/"));
  });

  it("rejects other CDNs", () => {
    assert.equal(isEsmShCdn("https://cdn.jsdelivr.net/npm/"), false);
    assert.equal(isEsmShCdn("https://unpkg.com/"), false);
  });
});

describe("jsrToCdnUrl", () => {
  it("maps jsr: specifiers to the esm.sh /jsr/ endpoint", () => {
    assert.equal(
      jsrToCdnUrl("jsr:@std/encoding@1.0.0/base64", "https://esm.sh/"),
      "https://esm.sh/jsr/@std/encoding@1.0.0/base64",
    );
    assert.equal(
      jsrToCdnUrl("jsr:@hono/hono@4", "https://esm.sh/"),
      "https://esm.sh/jsr/@hono/hono@4",
    );
    assert.equal(
      jsrToCdnUrl("jsr:@std/uuid", "https://esm.sh/"),
      "https://esm.sh/jsr/@std/uuid",
    );
  });

  it("throws on invalid specifiers", () => {
    assert.throws(
      () => jsrToCdnUrl("jsr:nope", "https://esm.sh/"),
      /Invalid JSR specifier/,
    );
  });
});

describe("hooks wiring", () => {
  const context: ResolveHookContext = {
    conditions: [],
    importAttributes: {},
    parentURL: undefined,
  };
  const nextResolve = (specifier: string) => ({ url: specifier });

  it("rejects jsr: specifiers when the CDN is not esm.sh", () => {
    // The test process runs without URL_IMPORT_CDN, so the feature is off.
    assert.throws(
      () => resolve("jsr:@std/uuid", context, nextResolve),
      /Cannot resolve "jsr:@std\/uuid"/,
    );
  });
});

// End-to-end through the CLI: --cdn defaults to esm.sh, which enables jsr:.
describe("jsr: end-to-end (network)", () => {
  const fixtureDir = join(tmpdir(), "node-url-import-jsr-test");
  const uuidScript = join(fixtureDir, "uuid.mjs");
  const subpathScript = join(fixtureDir, "subpath.mjs");

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: "utf-8",
      timeout: 60_000,
    });
  }

  before(() => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      uuidScript,
      `import { v1, NIL_UUID } from "jsr:@std/uuid";
       const id = v1.generate();
       console.log(JSON.stringify({ valid: v1.validate(id), nil: NIL_UUID }));`,
      "utf-8",
    );
    writeFileSync(
      subpathScript,
      `import { encodeBase64 } from "jsr:@std/encoding@1.0.10/base64";
       console.log(JSON.stringify({ b64: encodeBase64("hello") }));`,
      "utf-8",
    );
  });

  after(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("imports a jsr: package with --cdn (default esm.sh)", () => {
    const result = runCli(["--cdn", uuidScript]);
    assert.equal(
      result.status,
      0,
      `CLI exited with ${result.status}\nstderr: ${result.stderr}`,
    );
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.valid, true);
    assert.equal(typeof out.nil, "string");
  });

  it("imports a pinned jsr: subpath export", () => {
    const result = runCli(["--cdn", subpathScript]);
    assert.equal(
      result.status,
      0,
      `CLI exited with ${result.status}\nstderr: ${result.stderr}`,
    );
    assert.deepEqual(JSON.parse(result.stdout.trim()), { b64: "aGVsbG8=" });
  });

  it("fails with a clear error without --cdn", () => {
    const result = runCli([uuidScript]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot resolve "jsr:@std\/uuid"/);
  });
});
