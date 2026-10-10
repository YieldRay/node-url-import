import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResolveHookContext, LoadHookContext } from "node:module";
import { resolve, load, inferFormat, createResolve } from "./hooks.ts";
import { initialize, resolve as resolveLoader } from "./loader.ts";
import { cachePaths, writeCache } from "./cache.ts";
import { rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

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
    const result = resolve("npm:typescript@6", defaultResolveContext, next.fn);
    assert.equal(next.wasCalled(), true);
    assert.ok(result.url.startsWith("file:"));
  });

  it("should resolve relative imports against HTTP parent URL", () => {
    const next = makeNextResolve();
    const resolveFixture = createResolve((url) => ({
      url, finalUrl: url, source: "export default 1;", contentType: "application/javascript", redirectChain: [url],
    }));
    const result = resolveFixture("./foo.js", {
      ...defaultResolveContext,
      parentURL: "https://esm.sh/bar/index.js",
    }, next.fn);
    assert.equal(result.shortCircuit, true);
    assert.equal(result.url, "https://esm.sh/bar/foo.js");
    assert.equal(next.wasCalled(), false);
  });
});

describe("async loader initialization", () => {
  it("configures the already captured resolve function without replacing it", async () => {
    const url = "https://loader-initialize.test/main.mjs#entry";
    const capturedResolve = resolveLoader;
    writeCache([url], "export default 42;", "application/javascript");
    try {
      initialize({ mainUrl: url });
      assert.equal(resolveLoader, capturedResolve);
      const result = await capturedResolve(pathToFileURL(resolvePath(url)).href, defaultResolveContext,
        () => assert.fail("The remote main must not reach native file resolution"));
      assert.equal(result.url, url);
    } finally {
      initialize();
      rmSync(cachePaths(url).dir, { recursive: true, force: true });
    }
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

  it("should load remote TypeScript module with module-typescript format", async () => {
    const url = "https://typescript-load.test/mod.ts";
    const source = "export const value: number = 42;";
    writeCache([url], source, "text/typescript");
    try {
      const next = makeNextLoad();
      const result = load(url, defaultLoadContext, next.fn);
      assert.equal(result.shortCircuit, true);
      assert.equal(result.format, "module-typescript");
      assert.equal(result.source, source);
      assert.equal(next.wasCalled(), false);
      assert.equal((await import(url)).value, 42);
    } finally {
      rmSync(cachePaths(url).file, { force: true });
    }
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

  it("keeps .cts CommonJS semantics regardless of TypeScript MIME", () => {
    for (const contentType of ["application/javascript", "text/typescript", "application/typescript; charset=utf-8"]) {
      assert.equal(inferFormat("https://example.com/mod.cts", contentType), "commonjs-typescript");
    }
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
