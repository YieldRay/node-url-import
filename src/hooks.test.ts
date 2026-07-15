import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResolveHookContext, LoadHookContext } from "node:module";
import { resolve, load, inferFormat } from "./hooks.ts";

const defaultResolveContext: ResolveHookContext = {
  conditions: [],
  importAttributes: {},
  parentURL: undefined,
};

const defaultLoadContext: LoadHookContext = {
  conditions: [],
  format: null,
  importAttributes: {},
};

// A simple passthrough nextResolve that marks itself as called
function makeNextResolve() {
  let called = false;
  const fn = (specifier: string) => {
    called = true;
    return { url: specifier };
  };
  return { fn, wasCalled: () => called };
}

function makeNextLoad() {
  let called = false;
  const fn = (url: string) => {
    called = true;
    return { format: "module" as const, source: "" };
  };
  return { fn, wasCalled: () => called };
}

describe("hooks.resolve (sync)", () => {
  it("should resolve HTTP URLs", () => {
    const next = makeNextResolve();
    const result = resolve("https://esm.sh/ms@2.1.3", defaultResolveContext, next.fn);
    assert.equal(result.shortCircuit, true);
    assert.ok(result.url.startsWith("https://"));
    assert.equal(next.wasCalled(), false);
  });

  it("should pass through non-HTTP specifiers to nextResolve", () => {
    const next = makeNextResolve();
    const result = resolve("fs", defaultResolveContext, next.fn);
    assert.equal(next.wasCalled(), true);
    assert.equal(result.url, "fs");
  });

  it("should strip npm: specifiers and delegate to nextResolve", () => {
    const next = makeNextResolve();
    const result = resolve("npm:ms@2.1.3", defaultResolveContext, next.fn);
    assert.equal(next.wasCalled(), true);
    assert.equal(result.url, "ms");
  });

  it("should resolve relative imports against HTTP parent URL", () => {
    const next = makeNextResolve();
    const result = resolve("./foo.js", {
      ...defaultResolveContext,
      parentURL: "https://esm.sh/bar/index.js",
    }, next.fn);
    assert.equal(result.shortCircuit, true);
    assert.equal(result.url, "https://esm.sh/bar/foo.js");
    assert.equal(next.wasCalled(), false);
  });
});

describe("hooks.load (sync)", () => {
  it("should load HTTP URLs and return source", () => {
    const next = makeNextLoad();
    const result = load("https://esm.sh/ms@2.1.3", defaultLoadContext, next.fn);
    assert.equal(result.shortCircuit, true);
    assert.ok(result.format);
    assert.equal(typeof result.source, "string");
    assert.ok((result.source as string).length > 0);
    assert.equal(next.wasCalled(), false);
  });

  it("should pass through non-HTTP URLs to nextLoad", () => {
    const next = makeNextLoad();
    const result = load("file:///tmp/foo.js", defaultLoadContext, next.fn);
    assert.equal(next.wasCalled(), true);
  });

  it("should load remote TypeScript module with module-typescript format", () => {
    const next = makeNextLoad();
    const result = load("https://deno.land/std@0.224.0/path/mod.ts", defaultLoadContext, next.fn);
    assert.equal(result.shortCircuit, true);
    assert.equal(result.format, "module-typescript");
    assert.equal(typeof result.source, "string");
    assert.ok((result.source as string).length > 0);
    assert.equal(next.wasCalled(), false);
  });
});

describe("inferFormat", () => {
  it("should return module-typescript for .ts extension", () => {
    assert.equal(inferFormat("https://example.com/mod.ts", "application/javascript"), "module-typescript");
  });

  it("should return module-typescript for .tsx extension", () => {
    assert.equal(inferFormat("https://example.com/mod.tsx", "application/javascript"), "module-typescript");
  });

  it("should return module-typescript for .mts extension", () => {
    assert.equal(inferFormat("https://example.com/mod.mts", "application/javascript"), "module-typescript");
  });

  it("should return commonjs-typescript for .cts extension", () => {
    assert.equal(inferFormat("https://example.com/mod.cts", "application/javascript"), "commonjs-typescript");
  });

  it("should return module-typescript for text/typescript content-type", () => {
    assert.equal(inferFormat("https://example.com/mod", "text/typescript"), "module-typescript");
  });

  it("should return module-typescript for application/typescript content-type", () => {
    assert.equal(inferFormat("https://example.com/mod", "application/typescript; charset=utf-8"), "module-typescript");
  });

  it("should return module for .js extension", () => {
    assert.equal(inferFormat("https://example.com/mod.js", "application/javascript"), "module");
  });

  it("should return module for .mjs extension", () => {
    assert.equal(inferFormat("https://example.com/mod.mjs", "application/javascript"), "module");
  });

  it("should return commonjs for .cjs extension", () => {
    assert.equal(inferFormat("https://example.com/mod.cjs", "application/javascript"), "commonjs");
  });

  it("should return json for .json extension", () => {
    assert.equal(inferFormat("https://example.com/data.json", "application/json"), "json");
  });

  it("should return wasm for .wasm extension", () => {
    assert.equal(inferFormat("https://example.com/mod.wasm", "application/wasm"), "wasm");
  });

  it("should default to module for unknown extension", () => {
    assert.equal(inferFormat("https://example.com/mod", "application/javascript"), "module");
  });

  describe("when TypeScript type-stripping is unsupported (old Node)", () => {
    it("should throw an explicit error for .ts extension", () => {
      assert.throws(
        () => inferFormat("https://example.com/mod.ts", "application/javascript", false),
        /does not support type stripping/,
      );
    });

    it("should throw an explicit error for .tsx extension", () => {
      assert.throws(
        () => inferFormat("https://example.com/mod.tsx", "application/javascript", false),
        /does not support type stripping/,
      );
    });

    it("should throw an explicit error for .mts extension", () => {
      assert.throws(
        () => inferFormat("https://example.com/mod.mts", "application/javascript", false),
        /does not support type stripping/,
      );
    });

    it("should throw an explicit error for .cts extension", () => {
      assert.throws(
        () => inferFormat("https://example.com/mod.cts", "application/javascript", false),
        /does not support type stripping/,
      );
    });

    it("should throw an explicit error for text/typescript content-type", () => {
      assert.throws(
        () => inferFormat("https://example.com/mod", "text/typescript", false),
        /does not support type stripping/,
      );
    });

    it("should still resolve non-TypeScript formats without throwing", () => {
      assert.equal(inferFormat("https://example.com/mod.js", "application/javascript", false), "module");
      assert.equal(inferFormat("https://example.com/mod.cjs", "application/javascript", false), "commonjs");
      assert.equal(inferFormat("https://example.com/data.json", "application/json", false), "json");
      assert.equal(inferFormat("https://example.com/mod.wasm", "application/wasm", false), "wasm");
    });
  });
});
