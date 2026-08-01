import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResolveHookContext } from "node:module";

const defaultResolveContext: ResolveHookContext = {
  conditions: [],
  importAttributes: {},
  parentURL: undefined,
};

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
    const { resolve } = await import("./hooks.ts");

    const nextResolve = (spec: string) => ({
      url: `node:${spec}`,
      shortCircuit: true as const,
    });

    const ctx: ResolveHookContext = {
      ...defaultResolveContext,
      parentURL: "https://esm.sh/v135/some-package@1.0.0/es2022/index.mjs",
    };

    const result = resolve("node:fs", ctx, nextResolve);
    assert.ok(
      !result.url.startsWith("https://"),
      `Expected node built-in, got: ${result.url}`,
    );

    const result2 = resolve("fs/promises", ctx, nextResolve);
    assert.ok(
      !result2.url.startsWith("https://"),
      `Expected node built-in, got: ${result2.url}`,
    );

    const result3 = resolve("./util.js", ctx, nextResolve);
    assert.equal(
      result3.url,
      "https://esm.sh/v135/some-package@1.0.0/es2022/util.js",
    );
  });

  it("should strip HTTP parentURL when forwarding bare specifiers to nextResolve", async () => {
    const { resolve } = await import("./hooks.ts");

    // Regression: a bare npm package (not a node built-in) imported from an
    // HTTP module used to reach Node's default resolver with the HTTP
    // parentURL still in context, throwing `ERR_INVALID_URL`. The parentURL
    // must be dropped so Node resolves it from the local project.
    let seenParentURL: string | undefined = "unset";
    const nextResolve = (spec: string, ctx?: Partial<ResolveHookContext>) => {
      seenParentURL = ctx?.parentURL;
      return { url: `file:///node_modules/${spec}/index.js`, shortCircuit: true as const };
    };

    const ctx: ResolveHookContext = {
      ...defaultResolveContext,
      parentURL: "https://raw.githubusercontent.com/user/repo/main/api/ws.ts",
    };

    const result = resolve("ws", ctx, nextResolve);
    assert.equal(seenParentURL, undefined, "HTTP parentURL should be stripped");
    assert.ok(!result.url.startsWith("https://"));
  });
});
