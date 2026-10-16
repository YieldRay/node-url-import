import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

function runCli(args: string[], extraEnv: Record<string, string> = {}, input = "") {
  return spawnSync(process.execPath, ["src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DENO_DIR: join(fixtureDir, "deno"), TMPDIR: fixtureDir, ...extraEnv },
    encoding: "utf-8",
    input,
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
  it("lets Node read stdin when no arguments are given", () => {
    const result = runCli([], {}, "console.log(73)");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "73");
  });

  it("should print usage and exit 0 with --help", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.length > 0);
  });
});

  it("prints an expression with -p and the native -pe shorthand", () => {
    for (const flag of ["-p", "-pe"]) {
      const result = runCli([flag, "21 * 2"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "42");
    }
  });

  it("preserves eval arguments after -- without consuming own-looking flags", () => {
    const result = runCli(["--tmp", "--input-type=module", "--eval", DUMP_SCRIPT, "--", "argument", "--reload"]);
    assert.equal(result.status, 0, result.stderr);
    const output: Dump = JSON.parse(result.stdout);
    assert.deepEqual(output.argv, ["--reload"]);
    assert.equal(output.env.TMP, "1");
    assert.equal(output.env.RELOAD, undefined);
    assert.deepEqual(output.execArgv.slice(2), ["--input-type=module", "--eval", DUMP_SCRIPT]);
  });

  it("reads an explicit stdin entry with its script arguments", () => {
    const result = runCli(["--tmp", "-", "--reload", "--clear-cache"], {}, DUMP_SCRIPT);
    assert.equal(result.status, 0, result.stderr);
    const output: Dump = JSON.parse(result.stdout);
    assert.deepEqual(output.argv, ["--reload", "--clear-cache"]);
    assert.equal(output.env.TMP, "1");
    assert.equal(output.env.RELOAD, undefined);
  });

  it("forwards --version to Node", () => {
    const result = runCli(["--version"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), process.version);
  });

  it("leaves invalid Node flags and missing Node values for Node to reject", () => {
    for (const args of [["--not-a-node-option"], ["--title"], ["--eval"], ["--title", "--tmp"]]) {
      const expected = spawnSync(process.execPath, args, { encoding: "utf8", input: "" });
      const result = runCli(args);
      assert.equal(result.status, expected.status);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, expected.stdout);
    }
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

  it("should translate --reload to URL_IMPORT_RELOAD=1", () => {
    assert.equal(runDump(["--reload"]).env.RELOAD, "1");
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

  it("rejects unsupported negative and boolean-valued options", () => {
    for (const option of ["--no-cdn", "--cdn=false", "--no-frozen", "--frozen=false", "--reload=true", "--tmp=false"]) {
      assert.notEqual(runCli([option, dumpScript]).status, 0);
    }
  });

  it("preserves inherited settings without enabling a lock for frozen alone", () => {
    const result = runCli([dumpScript], { URL_IMPORT_FROZEN: "1", URL_IMPORT_CDN: "https://example.test/", URL_IMPORT_LOCK: "" });
    assert.equal(result.status, 0, result.stderr);
    const output: Dump = JSON.parse(result.stdout);
    assert.equal(output.env.FROZEN, "1");
    assert.equal(output.env.CDN, "https://example.test/");
    assert.equal(output.env.LOCK, "");
  });

  it("rejects missing option values before the script", () => {
    assert.notEqual(runCli(["--lock-file"]).status, 0);
  });

  it("lets the last CDN option determine the selected base", () => {
    assert.equal(runDump(["--cdn=https://example.test/", "--cdn"]).env.CDN, "https://esm.sh/");
    assert.equal(runDump(["--cdn", "--cdn=https://example.test/"]).env.CDN, "https://example.test/");
  });

  it("rejects non-HTTP and ambiguous CDN bases", () => {
    assert.notEqual(runCli(["--cdn=file:///tmp/", dumpScript]).status, 0);
    assert.notEqual(runCli(["--cdn=https://example.test/?query=1", dumpScript]).status, 0);
  });

  it("should combine multiple own flags", () => {
    const { env } = runDump(["--reload", "--tmp"]);
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
    // --reload is ours (→ env, not forwarded); --title is Node's (→ execArgv).
    const dump = runDump(["--reload", "--title=node-url-import-test"]);
    assert.equal(dump.env.RELOAD, "1");
    assert.ok(dump.execArgv.includes("--title=node-url-import-test"));
    assert.ok(!dump.execArgv.includes("--reload"));
  });

  it("keeps -r as Node's CommonJS preload and does not enable reload", () => {
    const preload = join(fixtureDir, "preload.cjs");
    writeFileSync(preload, 'process.env.CLI_PRELOADED = "1";');
    const result = runCli(["--tmp", "-r", preload, "-p", 'JSON.stringify({ preloaded: process.env.CLI_PRELOADED, reload: process.env.URL_IMPORT_RELOAD, tmp: process.env.URL_IMPORT_TMP, execArgv: process.execArgv })']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.preloaded, "1");
    assert.equal(output.reload, undefined);
    assert.equal(output.tmp, "1");
    assert.equal(output.execArgv[output.execArgv.indexOf("-r") + 1], preload);
  });

  it("does not inherit a remote main entry when a local script is selected", () => {
    const result = runCli([dumpScript], { URL_IMPORT_MAIN: "https://example.invalid/old-entry.mjs" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).env.MAIN, undefined);
  });

  it("preserves required Node option values after consuming leading own options", () => {
    const dump = runDump(["--tmp", "--title", "test-title", "--conditions", "test-condition"]);
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

  it("stops consuming own options when Node's arguments start", () => {
    const args = ["--title", "test-title", "--tmp", dumpScript];
    const expected = spawnSync(process.execPath, args, { encoding: "utf8", input: "" });
    const result = runCli(args);
    assert.notEqual(expected.status, 0);
    assert.equal(result.status, expected.status);
    assert.equal(result.stdout, expected.stdout);
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
  it("preserves the target's signal exit status", { skip: process.platform === "win32" }, () => {
    const result = runCli(["--eval", 'process.kill(process.pid, "SIGTERM");']);
    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGTERM");
  });

  it("forwards termination signals to the target instead of orphaning it", { skip: process.platform === "win32" }, async () => {
    const scriptPath = join(fixtureDir, "signal.mjs");
    const sentinelPath = join(fixtureDir, "terminated");
    writeFileSync(scriptPath, `
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(sentinelPath)}, "stopped"); process.exit(0); });
      console.log(process.pid);
      setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, ["src/cli.ts", scriptPath], {
      env: { ...process.env, DENO_DIR: join(fixtureDir, "deno") },
      stdio: ["ignore", "pipe", "pipe"], timeout: 5_000, killSignal: "SIGKILL",
    });
    const completed = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (status, signal) => resolve({ status, signal }));
    });
    let targetPid: number | undefined;
    try {
      assert.ok(child.stdout);
      const [output] = await once(child.stdout, "data", { signal: AbortSignal.timeout(3_000) });
      targetPid = Number(String(output).trim());
      assert.ok(Number.isInteger(targetPid) && targetPid > 0);
      child.kill("SIGTERM");
      const result = await completed;
      assert.equal(result.status, 0);
      assert.equal(result.signal, null);
      assert.equal(readFileSync(sentinelPath, "utf8"), "stopped");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (targetPid) {
        try { process.kill(targetPid, "SIGKILL"); } catch { /* Target already exited. */ }
      }
    }
  });

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

