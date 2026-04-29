import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("npm: specifier", () => {
  it("should strip npm: prefix and resolve from node_modules", async () => {
    // @ts-expect-error: npm: specifier resolved by our loader at runtime
    const ts = await import("npm:typescript");
    assert.equal(typeof ts.default.version, "string");
  });
});
