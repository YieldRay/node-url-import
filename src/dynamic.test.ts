import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("dynamic import", () => {
  it("should import lodash-es/add from esm.sh", async () => {
    // @ts-expect-error: HTTP URL resolved by our loader at runtime
    const mod = await import("https://esm.sh/lodash-es@4.17.21/add");
    assert.equal(typeof mod.default, "function");
    assert.equal(mod.default(1, 2), 3);
  });
});
