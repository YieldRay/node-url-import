import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashSource } from "./lock.ts";

describe("lock file", () => {
  it("should compute bare sha256 hex hashes (Deno-compatible)", () => {
    const hash = hashSource("hello world");
    assert.equal(
      hash,
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    assert.ok(!hash.startsWith("sha256-"));
  });
});
