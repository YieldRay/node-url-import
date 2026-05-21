import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, load } from "./hooks.ts";

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
    const result = resolve("https://esm.sh/ms@2.1.3", {}, next.fn);
    assert.equal(result.shortCircuit, true);
    assert.ok(result.url.startsWith("https://"));
    assert.equal(next.wasCalled(), false);
  });

  it("should pass through non-HTTP specifiers to nextResolve", () => {
    const next = makeNextResolve();
    const result = resolve("fs", {}, next.fn);
    assert.equal(next.wasCalled(), true);
    assert.equal(result.url, "fs");
  });

  it("should strip npm: specifiers and delegate to nextResolve", () => {
    const next = makeNextResolve();
    const result = resolve("npm:ms@2.1.3", {}, next.fn);
    assert.equal(next.wasCalled(), true);
    assert.equal(result.url, "ms");
  });

  it("should resolve relative imports against HTTP parent URL", () => {
    const next = makeNextResolve();
    const result = resolve("./foo.js", {
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
    const result = load("https://esm.sh/ms@2.1.3", {}, next.fn);
    assert.equal(result.shortCircuit, true);
    assert.ok(result.format);
    assert.equal(typeof result.source, "string");
    assert.ok((result.source as string).length > 0);
    assert.equal(next.wasCalled(), false);
  });

  it("should pass through non-HTTP URLs to nextLoad", () => {
    const next = makeNextLoad();
    const result = load("file:///tmp/foo.js", {}, next.fn);
    assert.equal(next.wasCalled(), true);
  });
});
