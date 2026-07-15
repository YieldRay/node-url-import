import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchModule } from "./fetch.ts";

describe("fetchModule", () => {
  it("should reject with a descriptive error on a 404", async () => {
    await assert.rejects(
      () => fetchModule("https://esm.sh/this-package-does-not-exist-xyz-999"),
      /Failed to fetch|404/,
    );
  });

  it("should still succeed after a failed fetch (progress state not left stuck)", async () => {
    // A failed fetch must not leave the download-progress counters unbalanced;
    // if it did, this second fetch's completion bookkeeping could be affected.
    await assert.rejects(() =>
      fetchModule("https://esm.sh/this-package-does-not-exist-xyz-999"),
    );

    const result = await fetchModule("https://esm.sh/ms@2.1.3");
    assert.equal(typeof result.source, "string");
    assert.ok(result.source.length > 0);
    assert.ok(result.finalUrl.startsWith("https://"));
  });
});
