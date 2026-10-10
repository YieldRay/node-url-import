import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
const fixtureDir = mkdtempSync(join(tmpdir(), "node-url-import-cli-test-"));

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
    env: { ...process.env, DENO_DIR: join(fixtureDir, "deno"), TMPDIR: fixtureDir, ...extraEnv },
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
    assert.ok(result.stdout.length > 0);
  });

  it("should print usage and exit 0 with --help", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.length > 0);
  });
});

describe("CLI: --clear-cache", () => {
  it("should clear the cache and exit 0", () => {
    mkdirSync(join(fixtureDir, "deno", "remote"), { recursive: true });
    writeFileSync(join(fixtureDir, "deno", "remote", "sentinel"), "fixture");
    const result = runCli(["--clear-cache"]);
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(fixtureDir, "deno", "remote")), false);
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

  it("forwards every own option after the script without changing loader configuration", () => {
    const scriptArgs = ["--reload", "--tmp", "--lock", "--frozen", "--cdn=https://example.test/", "--lock-file"];
    const result = runCli([dumpScript, ...scriptArgs]);
    assert.equal(result.status, 0, result.stderr);
    const output: Dump = JSON.parse(result.stdout);
    assert.deepEqual(output.argv, scriptArgs);
    assert.deepEqual(output.env, {});
  });

  it("does not clear the cache for a script's --clear-cache argument", () => {
    const remoteDirectory = join(fixtureDir, "deno", "remote");
    mkdirSync(remoteDirectory, { recursive: true });
    const sentinel = join(remoteDirectory, "preserved");
    writeFileSync(sentinel, "fixture");
    const result = runCli([dumpScript, "--clear-cache"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).argv, ["--clear-cache"]);
    assert.equal(existsSync(sentinel), true);
  });

  it("supports -- before flag-like script names without leaking the separator", () => {
    const scriptPath = join(process.cwd(), "-cli-flag-fixture.mjs");
    writeFileSync(scriptPath, DUMP_SCRIPT);
    try {
      const result = runCli(["--", "-cli-flag-fixture.mjs", "argument"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).argv, ["argument"]);
    } finally {
      rmSync(scriptPath, { force: true });
    }
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

  it("allows explicitly disabling inherited frozen mode", () => {
    const result = runCli(["--frozen=false", dumpScript], { URL_IMPORT_FROZEN: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(JSON.parse(result.stdout).env.FROZEN, "1");
  });

  it("allows explicitly disabling an inherited CDN", () => {
    const result = runCli(["--cdn=false", dumpScript], { URL_IMPORT_CDN: "https://example.test/" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).env.CDN, undefined);
  });

  it("rejects missing option values before the script", () => {
    assert.notEqual(runCli(["--lock-file"]).status, 0);
  });

  it("lets the last CDN option determine the selected base", () => {
    assert.equal(runDump(["--cdn=https://example.test/", "--cdn"]).env.CDN, "https://esm.sh/");
    assert.equal(runDump(["--cdn=https://example.test/", "--no-cdn"]).env.CDN, undefined);
  });

  it("rejects non-HTTP and ambiguous CDN bases", () => {
    assert.notEqual(runCli(["--cdn=file:///tmp/", dumpScript]).status, 0);
    assert.notEqual(runCli(["--cdn=https://example.test/?query=1", dumpScript]).status, 0);
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

  it("does not inherit a remote main entry when a local script is selected", () => {
    const result = runCli([dumpScript], { URL_IMPORT_MAIN: "https://example.invalid/old-entry.mjs" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).env.MAIN, undefined);
  });

  it("preserves required Node option values mixed with own options", () => {
    const dump = runDump(["--title", "test-title", "--tmp", "--conditions", "test-condition"]);
    assert.equal(dump.env.TMP, "1");
    assert.deepEqual(dump.argv, []);
    const titleIndex = dump.execArgv.indexOf("--title");
    const conditionIndex = dump.execArgv.indexOf("--conditions");
    assert.equal(dump.execArgv[titleIndex + 1], "test-title");
    assert.equal(dump.execArgv[conditionIndex + 1], "test-condition");
  });

  it("forwards Node preload and environment-file values", () => {
    const preload = join(fixtureDir, "preload.mjs");
    const envFile = join(fixtureDir, "runtime.env");
    writeFileSync(preload, "");
    writeFileSync(envFile, "CLI_TEST_VALUE=fixture\n");
    const dump = runDump(["--import", preload, "--env-file", envFile]);
    const preloadIndex = dump.execArgv.lastIndexOf("--import");
    const envIndex = dump.execArgv.indexOf("--env-file");
    assert.equal(dump.execArgv[preloadIndex + 1], preload);
    assert.equal(dump.execArgv[envIndex + 1], envFile);
  });

  it("does not consume the script as an optional inspector value", () => {
    const dump = runDump(["--inspect"]);
    assert.ok(dump.execArgv.includes("--inspect"));
    assert.deepEqual(dump.argv, []);
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

