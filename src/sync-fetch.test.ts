import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchModuleSync } from "./sync-fetch.ts";

describe("fetchModuleSync", () => {
  it("should fetch a module synchronously from esm.sh", () => {
    const result = fetchModuleSync("https://esm.sh/ms@2.1.3");
    assert.equal(typeof result.source, "string");
    assert.ok(result.source.length > 0);
    assert.ok(
      result.contentType.includes("javascript") ||
        result.contentType.includes("typescript"),
    );
    assert.equal(typeof result.finalUrl, "string");
    assert.ok(result.finalUrl.startsWith("https://"));
  });

  it("should return cached result on second call", () => {
    // First call populates cache
    const first = fetchModuleSync("https://esm.sh/ms@2.1.3");
    // Second call should hit disk cache (much faster)
    const second = fetchModuleSync("https://esm.sh/ms@2.1.3");
    assert.equal(first.source, second.source);
    assert.equal(first.finalUrl, second.finalUrl);
  });

  it("should throw on invalid URL", () => {
    assert.throws(
      () => fetchModuleSync("https://esm.sh/this-package-does-not-exist-xyz-999"),
      /Failed to fetch|404/,
    );
  });
});
