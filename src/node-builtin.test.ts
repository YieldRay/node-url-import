import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("node built-in from remote module", () => {
  it("should resolve node: specifiers to built-ins, not HTTP URLs", async () => {
    const { readFile } = await import("node:fs/promises");
    assert.equal(typeof readFile, "function");
  });

  it("should allow remote and node built-in imports side by side", async () => {
    const [lodash, path] = await Promise.all([
      // @ts-expect-error: HTTP URL resolved by our loader at runtime
      import("https://esm.sh/lodash-es@4.17.21/add"),
      import("node:path"),
    ]);
    assert.equal(typeof lodash.default, "function");
    assert.equal(typeof path.join, "function");
  });

  it("should not resolve bare specifiers against HTTP parent URL", async () => {
    const { resolve } = await import("./loader.ts");

    const nextResolve = async (spec: string) => ({
      url: `node:${spec}`,
      shortCircuit: true as const,
    });

    const result = await resolve(
      "node:fs",
      {
        parentURL:
          "https://esm.sh/v135/some-package@1.0.0/es2022/index.mjs",
      },
      nextResolve,
    );
    assert.ok(
      !result.url.startsWith("https://"),
      `Expected node built-in, got: ${result.url}`,
    );

    const result2 = await resolve(
      "fs/promises",
      {
        parentURL:
          "https://esm.sh/v135/some-package@1.0.0/es2022/index.mjs",
      },
      nextResolve,
    );
    assert.ok(
      !result2.url.startsWith("https://"),
      `Expected node built-in, got: ${result2.url}`,
    );

    const result3 = await resolve(
      "./util.js",
      {
        parentURL:
          "https://esm.sh/v135/some-package@1.0.0/es2022/index.mjs",
      },
      nextResolve,
    );
    assert.equal(
      result3.url,
      "https://esm.sh/v135/some-package@1.0.0/es2022/util.js",
    );
  });
});
