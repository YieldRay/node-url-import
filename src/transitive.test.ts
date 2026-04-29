import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("transitive dependencies", () => {
  it("should import lodash-es with sub-module resolution from esm.sh", async () => {
    const { add, multiply, chunk } = await import(
      // @ts-expect-error: HTTP URL resolved by our loader at runtime
      "https://esm.sh/lodash-es@4.17.21"
    );
    assert.equal(add(2, 3), 5);
    assert.equal(multiply(4, 5), 20);
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });
});
