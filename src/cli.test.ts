import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { NAME } from "./constants.ts";

const fixtureDir = join(tmpdir(), "node-url-import-cli-test");

// Prints the flag-relevant environment the CLI translates its own flags into,
// plus the script args it received. Lets us assert arg-splitting and
// flag → env translation from a single local fixture (no network).
const DUMP_SCRIPT = `console.log(JSON.stringify({
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  env: {
    RELOAD: process.env.URL_IMPORT_RELOAD,
    TMP: process.env.URL_IMPORT_TMP,
    LOCK: process.env.URL_IMPORT_LOCK,
    FROZEN: process.env.URL_IMPORT_FROZEN,
    MAIN: process.env.URL_IMPORT_MAIN,
    CDN: process.env.URL_IMPORT_CDN,
  },
}));
`;

const dumpScript = join(fixtureDir, "dump.mjs");

interface Dump {
  argv: string[];
  execArgv: string[];
  env: {
    RELOAD?: string;
    TMP?: string;
    LOCK?: string;
    FROZEN?: string;
    MAIN?: string;
    CDN?: string;
  };
}

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    encoding: "utf-8",
    timeout: 30_000,
  });
}

// Run the CLI against the dump fixture and parse its JSON output.
function runDump(args: string[]): Dump {
  const result = runCli([...args, dumpScript]);
  assert.equal(
    result.status,
    0,
    `CLI exited with ${result.status}\nstderr: ${result.stderr}`,
  );
  return JSON.parse(result.stdout.trim());
}

before(() => {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(dumpScript, DUMP_SCRIPT, "utf-8");
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("CLI: help and usage", () => {
  it("should print usage and exit 0 with no arguments", () => {
    const result = runCli([]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes(NAME));
    assert.ok(result.stdout.includes("Usage:"));
  });

  it("should print usage and exit 0 with --help", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("Usage:"));
    assert.ok(result.stdout.includes("Options:"));
  });
});

describe("CLI: --clear-cache", () => {
  it("should clear the cache and exit 0", () => {
    const result = runCli(["--clear-cache"]);
    assert.equal(result.status, 0);
    assert.ok(
      result.stdout.includes("Cache cleared"),
      `Expected confirmation, got: ${result.stdout}`,
    );
  });
});

describe("CLI: script argument forwarding", () => {
  // Script args go *after* the target, so these bypass runDump (which appends
  // the fixture path at the end) and invoke the CLI directly.
  function argvAfter(scriptArgs: string[]): string[] {
    const result = runCli([dumpScript, ...scriptArgs]);
    assert.equal(result.status, 0, result.stderr);
    return (JSON.parse(result.stdout.trim()) as Dump).argv;
  }

  it("should not leak a stray '--' into process.argv when no script args are given", () => {
    assert.deepEqual(argvAfter([]), []);
  });

  it("should forward plain script args after the script", () => {
    assert.deepEqual(argvAfter(["foo", "bar"]), ["foo", "bar"]);
  });

  it("should forward flag-like args placed after the script", () => {
    // Args after the script positional are script args, even if flag-like.
    assert.deepEqual(argvAfter(["-h", "--verbose"]), ["-h", "--verbose"]);
  });
});

describe("CLI: own-flag to env translation", () => {
  it("should not set any URL_IMPORT_* vars when no own flags are passed", () => {
    const { env } = runDump([]);
    assert.equal(env.RELOAD, undefined);
    assert.equal(env.TMP, undefined);
    assert.equal(env.LOCK, undefined);
    assert.equal(env.FROZEN, undefined);
  });

  it("should translate --reload / -r to URL_IMPORT_RELOAD=1", () => {
    assert.equal(runDump(["--reload"]).env.RELOAD, "1");
    assert.equal(runDump(["-r"]).env.RELOAD, "1");
  });

  it("should translate --tmp to URL_IMPORT_TMP=1", () => {
    assert.equal(runDump(["--tmp"]).env.TMP, "1");
  });

  it("should translate --lock to URL_IMPORT_LOCK=<cwd>/deno.lock", () => {
    assert.equal(runDump(["--lock"]).env.LOCK, resolvePath("deno.lock"));
  });

  it("should translate --lock-file <path> to an absolute URL_IMPORT_LOCK", () => {
    const { env } = runDump(["--lock-file", "custom.lock"]);
    assert.equal(env.LOCK, resolvePath("custom.lock"));
  });

  it("should translate --frozen to URL_IMPORT_FROZEN=1 and imply a lock file", () => {
    const { env } = runDump(["--frozen"]);
    assert.equal(env.FROZEN, "1");
    assert.equal(env.LOCK, resolvePath("deno.lock"));
  });

  it("should combine multiple own flags", () => {
    const { env } = runDump(["-r", "--tmp"]);
    assert.equal(env.RELOAD, "1");
    assert.equal(env.TMP, "1");
  });

  it("should not set URL_IMPORT_CDN without --cdn", () => {
    assert.equal(runDump([]).env.CDN, undefined);
  });

  it("should translate bare --cdn to the default CDN base", () => {
    assert.equal(runDump(["--cdn"]).env.CDN, "https://esm.sh/");
  });

  it("should translate --cdn=<url> to that base, adding a trailing slash", () => {
    assert.equal(runDump(["--cdn=https://cdn.example.com"]).env.CDN, "https://cdn.example.com/");
    assert.equal(runDump(["--cdn=https://esm.sh/"]).env.CDN, "https://esm.sh/");
  });

  it("should not swallow the target when --cdn has no value", () => {
    // A bare --cdn must not consume the following positional as its value.
    const dump = runDump(["--cdn"]);
    assert.equal(dump.env.CDN, "https://esm.sh/");
    assert.deepEqual(dump.argv, []);
  });
});

describe("CLI: node flag pass-through", () => {
  it("should forward unknown flags before the script to node without leaking into argv", () => {
    // --title is a harmless node flag; it must reach node's execArgv and must
    // not leak into the script's process.argv.
    const dump = runDump(["--title=node-url-import-test"]);
    assert.deepEqual(dump.argv, []);
    assert.ok(
      dump.execArgv.includes("--title=node-url-import-test"),
      `node flag not forwarded to child execArgv: ${JSON.stringify(dump.execArgv)}`,
    );
  });

  it("should forward node flags while consuming its own flags", () => {
    // -r is ours (→ env, not forwarded); --title is node's (→ execArgv).
    const dump = runDump(["-r", "--title=node-url-import-test"]);
    assert.equal(dump.env.RELOAD, "1");
    assert.ok(dump.execArgv.includes("--title=node-url-import-test"));
    assert.ok(!dump.execArgv.some((a) => a.startsWith("-r")));
  });

  it("should not set URL_IMPORT_MAIN for a local file target", () => {
    assert.equal(runDump([]).env.MAIN, undefined);
  });
});

describe("CLI: --cdn bare-specifier resolution", () => {
  it("should resolve a bare specifier via the CDN and keep node built-ins local", () => {
    const scriptPath = join(fixtureDir, "cdn-bare.mjs");
    writeFileSync(
      scriptPath,
      // `ms` is a bare npm package (→ CDN); `node:path` is a built-in (→ local).
      `import ms from "ms";\n` +
        `import { join } from "node:path";\n` +
        `console.log(JSON.stringify({ ms: ms(1000), join: typeof join }));\n`,
      "utf-8",
    );

    const result = runCli(["--cdn", scriptPath]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.ms, "1s");
    assert.equal(out.join, "function");
  });

  it("should fail to resolve a bare specifier without --cdn", () => {
    const scriptPath = join(fixtureDir, "no-cdn-bare.mjs");
    writeFileSync(scriptPath, `import "ms";\n`, "utf-8");
    const result = runCli([scriptPath]);
    assert.notEqual(result.status, 0);
    assert.ok(
      /ERR_MODULE_NOT_FOUND|Cannot find package/.test(result.stderr),
      `Expected module-not-found, got: ${result.stderr}`,
    );
  });
});

describe("CLI: exit code propagation", () => {
  it("should propagate a non-zero exit code from the target script", () => {
    const exitScript = join(fixtureDir, "exit.mjs");
    writeFileSync(exitScript, "process.exit(3);\n", "utf-8");
    const result = runCli([exitScript]);
    assert.equal(result.status, 3);
  });

  it("should exit 0 when the target script succeeds", () => {
    const okScript = join(fixtureDir, "ok.mjs");
    writeFileSync(okScript, "process.exit(0);\n", "utf-8");
    const result = runCli([okScript]);
    assert.equal(result.status, 0);
  });
});

