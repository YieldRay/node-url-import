import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("static import", () => {
  it("should import ms from esm.sh", async () => {
    // @ts-expect-error: HTTP URL resolved by our loader at runtime
    const { default: ms } = await import("https://esm.sh/ms@2.1.3");
    assert.equal(typeof ms, "function");
    assert.equal(ms("2 days"), 172800000);
    assert.equal(ms(60000), "1m");
  });
});
