import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResolveHookContext } from "node:module";
import { createResolve } from "./hooks.ts";

const remoteContext: ResolveHookContext = {
  conditions: [], importAttributes: {}, parentURL: "https://modules.test/main.mjs",
};
const resolve = createResolve((url) => ({
  source: "export default 1;", contentType: "application/javascript", url, finalUrl: url, redirectChain: [url],
}));

describe("node built-ins and local packages from remote modules", () => {
  it("delegates built-ins without interpreting them as relative URLs", () => {
    for (const specifier of ["node:fs", "fs/promises", "http", "node:path"]) {
      const result = resolve(specifier, remoteContext, (specifier, context) => {
        assert.ok(context?.parentURL?.startsWith("file:"));
        return { url: specifier, shortCircuit: true };
      });
      assert.equal(result.url, specifier);
    }
  });

  it("resolves installed packages from the project instead of the HTTP parent", () => {
    const result = resolve("typescript", remoteContext, (specifier, context) => {
      assert.ok(context?.parentURL?.startsWith("file:"));
      return { url: specifier };
    });
    assert.equal(result.url, "typescript");
  });

  it("resolves remote relative imports without involving the local resolver", () => {
    const result = resolve("./util.js", remoteContext, () => {
      assert.fail("Remote dependencies must not reach the local resolver");
    });
    assert.equal(result.url, "https://modules.test/util.js");
  });
});
