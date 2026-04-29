import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripNpmSpecifier } from "./loader.ts";

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

  it("should resolve from node_modules at runtime", async () => {
    // @ts-expect-error: npm: specifier resolved by our loader at runtime
    const ts = await import("npm:typescript");
    assert.equal(typeof ts.default.version, "string");
  });
});
