import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fetchModuleSync } from "./sync-fetch.ts";
import { cachePaths } from "./cache.ts";

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

  it("should write a cache entry to disk after fetching", () => {
    const url = "https://esm.sh/ms@2.1.3";
    const first = fetchModuleSync(url);

    // The requested URL must have a cache entry on disk after fetching
    // (either a source entry or a redirect stub pointing at the resolved URL).
    assert.ok(
      existsSync(cachePaths(url).file),
      "expected a cache entry for the requested URL after fetching",
    );
    // The final (post-redirect) URL must have its own source entry cached.
    assert.ok(
      existsSync(cachePaths(first.finalUrl).file),
      "expected a cache entry for the final URL after fetching",
    );

    // A second call returns the same content from that cache.
    const second = fetchModuleSync(url);
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
