import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createResolve, stripNpmSpecifier } from "./hooks.ts";
import type { ResolveHookContext } from "node:module";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

describe("npm: specifier", () => {
  it("should strip npm: prefix", () => {
    assert.equal(stripNpmSpecifier("npm:ms"), "ms");
    assert.equal(stripNpmSpecifier("npm:lodash-es"), "lodash-es");
  });

  it("should strip npm: prefix and version", () => {
    assert.equal(stripNpmSpecifier("npm:ms@2.1.3"), "ms");
    assert.equal(stripNpmSpecifier("npm:lodash-es@4.17.21"), "lodash-es");
  });

  it("should handle scoped packages", () => {
    assert.equal(stripNpmSpecifier("npm:@types/node"), "@types/node");
    assert.equal(stripNpmSpecifier("npm:@scope/pkg"), "@scope/pkg");
  });

  it("should strip version from scoped packages", () => {
    assert.equal(stripNpmSpecifier("npm:@types/node@22.0.0"), "@types/node");
    assert.equal(stripNpmSpecifier("npm:@scope/pkg@1.0.0"), "@scope/pkg");
  });

  it("should preserve subpath", () => {
    assert.equal(stripNpmSpecifier("npm:lodash-es/add"), "lodash-es/add");
    assert.equal(
      stripNpmSpecifier("npm:lodash-es@4.17.21/add"),
      "lodash-es/add",
    );
  });

  it("should preserve subpath for scoped packages", () => {
    assert.equal(stripNpmSpecifier("npm:@scope/pkg/sub"), "@scope/pkg/sub");
    assert.equal(
      stripNpmSpecifier("npm:@scope/pkg@1.0.0/sub"),
      "@scope/pkg/sub",
    );
    assert.equal(
      stripNpmSpecifier("npm:@scope/pkg@1.0.0/deep/path"),
      "@scope/pkg/deep/path",
    );
  });

  it("falls back to the default CDN while preserving versions and subpaths", () => {
    const context: ResolveHookContext = { conditions: [], importAttributes: {}, parentURL: "https://modules.test/main.mjs" };
    const fetched: string[] = [];
    const resolve = createResolve((url) => {
      fetched.push(url);
      return { url, finalUrl: url, source: "export default 1;", contentType: "application/javascript", redirectChain: [url] };
    });
    const specifiers = ["npm:node-url-import-missing@2/sub", "npm:@url-import-test/missing@3/deep/path"];
    for (const specifier of specifiers) {
      const result = resolve(specifier, context, () => assert.fail("Missing packages should fall back to HTTP"));
      assert.equal(result.url, `https://esm.sh/${specifier.slice(4)}`);
    }
    assert.deepEqual(fetched, specifiers.map((specifier) => `https://esm.sh/${specifier.slice(4)}`));
  });

  it("should resolve from node_modules at runtime", async () => {
    // @ts-expect-error: npm: specifier resolved by our loader at runtime
    const ts = await import("npm:typescript");
    assert.equal(typeof ts.default.version, "string");
  });
});

describe("npm: local package resolution", () => {
  let workspace: string;
  let parentURL: string;
  before(() => {
    workspace = mkdtempSync(join(tmpdir(), "node-url-import-package-test-"));
    const packageDirectory = join(workspace, "node_modules", "installed-fixture");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "installed-fixture", type: "module", exports: { ".": { require: "./require.mjs", import: "./import.mjs" } },
    }));
    writeFileSync(join(packageDirectory, "require.mjs"), "export default 'require';");
    writeFileSync(join(packageDirectory, "import.mjs"), "export default 'import';");
    parentURL = pathToFileURL(join(workspace, "app.mjs")).href;
  });
  after(() => { rmSync(workspace, { recursive: true, force: true }); });

  it("uses require resolution for installed npm packages", () => {
    const resolve = createResolve(() => assert.fail("Installed packages must remain local"));
    const result = resolve("npm:installed-fixture@1", { conditions: [], importAttributes: {}, parentURL }, (url) => ({ url }));
    assert.equal(result.url, pathToFileURL(realpathSync(join(workspace, "node_modules", "installed-fixture", "require.mjs"))).href);
  });

  it("preserves local export errors instead of downloading an installed package", () => {
    const resolve = createResolve(() => assert.fail("Invalid local exports must not fall back to HTTP"));
    assert.throws(() => resolve("npm:installed-fixture/private", { conditions: [], importAttributes: {}, parentURL },
      (url) => ({ url })), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  });
});
