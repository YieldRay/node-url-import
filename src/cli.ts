#!/usr/bin/env node

import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseArgs, styleText } from "node:util";
import { NAME, isHttpUrl } from "./constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Argument layout:
//   node-url-import [our-flags] [node-flags] <script-or-url> [script-args]
//
// parseArgs with strict:false consumes known flags and leaves unknown ones.
// We use tokens:true to identify which args are ours vs unknown (node flags)
// vs positionals (target + script args).

const allArgs = process.argv.slice(2);

const { values, tokens } = parseArgs({
  args: allArgs,
  options: {
    help: { type: "boolean", default: false },
    "clear-cache": { type: "boolean", default: false },
    "local-meta": { type: "boolean", default: false },
    reload: { type: "boolean", short: "r", default: false },
    lock: { type: "boolean", default: false },
    "lock-file": { type: "string" },
    frozen: { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: true,
  tokens: true,
});

// Find the first positional token — that's the target script/URL.
// Everything before it that's an unknown option token is a node flag.
// Everything after it (remaining positionals + any flags) is script args.
const firstPositional = tokens!.find((t) => t.kind === "positional");
const targetIdx = firstPositional?.index;

let target: string | undefined;
let nodeFlags: string[] = [];
let scriptArgs: string[] = [];

if (targetIdx !== undefined) {
  target = allArgs[targetIdx];
  // Node flags = unknown option tokens whose index < targetIdx
  // We reconstruct them from the raw argv to preserve --flag=value forms.
  for (const t of tokens!) {
    if (t.kind === "option" && t.index < targetIdx && !(t.name in values)) {
      // Unknown option — pass through to node
      const raw = allArgs[t.index]!;
      nodeFlags.push(raw);
      // If the token consumed a value from the next arg (not inline =), include it
      if (t.value !== undefined && !raw.includes("=")) {
        nodeFlags.push(allArgs[t.index + 1]!);
      }
    }
  }
  // Script args = everything after the target in raw argv
  scriptArgs = allArgs.slice(targetIdx + 1);
}

// Show help if --help is passed without a target, or no args at all.
if ((values.help && !target) || (!target && !values["clear-cache"])) {
  const dim = (s: string) => styleText("dim", s);
  const y = (s: string) => styleText("yellow", s);
  const c = (s: string) => styleText("cyan", s);
  const b = (s: string) => styleText("bold", s);
  console.log(`
${b(NAME)} ${dim("—")} run Node.js scripts that import from HTTP(S) URLs

${b("Usage:")}
  ${c(NAME)} ${dim("[options]")} ${dim("[node-flags]")} ${dim("<script-or-url>")} ${dim("[script-args...]")}
  ${c(NAME)} ${y("--clear-cache")}

  Flags before the script are split into ${NAME} options and Node.js flags.
  Flags after the script are forwarded to the remote script as-is.

${b("Examples:")}
  ${dim("$")} ${c(NAME)} ./app.mjs
  ${dim("$")} ${c(NAME)} https://esm.sh/dler
  ${dim("$")} ${c(NAME)} ${y("-r")} ./app.mjs                 ${dim("# reload remote modules")}
  ${dim("$")} ${c(NAME)} ${y("--lock")} ./app.mjs             ${dim("# check/write deno.lock")}
  ${dim("$")} ${c(NAME)} ${y("--inspect")} ./app.mjs          ${dim("# pass --inspect to node")}
  ${dim("$")} ${c(NAME)} https://example.com/cli.js -h   ${dim("# -h forwarded to script")}

${b("Options:")}
  ${y("-r, --reload")}             Bypass cache, re-fetch all remote modules
  ${y("--lock")}                   Check/write a lock file ${dim("(default: ./deno.lock)")}
  ${y("--lock-file")} ${dim("<path>")}       Lock file path ${dim("(implies --lock)")}
  ${y("--frozen")}                 Error if lock file is out of date ${dim("(use with --lock)")}
  ${y("--local-meta")}             Rewrite import.meta.url to a local file:// URL
                          ${dim("(fixes createRequire(import.meta.url) in remote modules)")}

${b("Environment:")}
  ${y("URL_IMPORT_CACHE_DIR")}     Custom cache directory
                          ${dim("(default: ~/.cache/" + NAME + ")")}
  ${y("URL_IMPORT_LOCAL_META=1")}   Same as --local-meta
  ${y("URL_IMPORT_RELOAD=1")}      Same as --reload
  ${y("URL_IMPORT_LOCK")}${dim("=path")}     Same as --lock <file>
  ${y("URL_IMPORT_FROZEN=1")}      Same as --frozen
`);
  process.exit(0);
}

if (values["clear-cache"]) {
  const { clearCache } = await import("./cache.ts");
  await clearCache();
  console.log(`${styleText("green", "✓")} Cache cleared.`);
  process.exit(0);
}

const registerPath: string = resolve(__dirname, "register.ts");

const nodeVersion: number[] = process.versions.node.split(".").map(Number);
const supportsImport: boolean =
  nodeVersion[0]! > 20 ||
  (nodeVersion[0] === 20 && nodeVersion[1]! >= 6) ||
  (nodeVersion[0] === 18 && nodeVersion[1]! >= 19);

// Build node command:
//   node [--import register] [node-flags] <target-or-eval> -- [script-args]
let nodeArgs: string[];

if (isHttpUrl(target!)) {
  const evalScript = `import ${JSON.stringify(target)};`;

  if (supportsImport) {
    nodeArgs = [
      "--import",
      registerPath,
      ...nodeFlags,
      "--input-type=module",
      "-e",
      evalScript,
      "--",
      ...scriptArgs,
    ];
  } else {
    const loaderPath = resolve(__dirname, "loader.ts");
    nodeArgs = [
      "--loader",
      loaderPath,
      ...nodeFlags,
      "--input-type=module",
      "-e",
      evalScript,
      "--",
      ...scriptArgs,
    ];
  }
} else {
  if (supportsImport) {
    nodeArgs = [
      "--import",
      registerPath,
      ...nodeFlags,
      target!,
      "--",
      ...scriptArgs,
    ];
  } else {
    const loaderPath = resolve(__dirname, "loader.ts");
    nodeArgs = [
      "--experimental-loader",
      loaderPath,
      ...nodeFlags,
      target!,
      "--",
      ...scriptArgs,
    ];
  }
}

// Pass our flags to the child process via environment variables.
const env: Record<string, string | undefined> = { ...process.env };

if (values["local-meta"]) {
  env.URL_IMPORT_LOCAL_META = "1";
}
if (values.reload) {
  env.URL_IMPORT_RELOAD = "1";
}
if (values["lock-file"]) {
  env.URL_IMPORT_LOCK = resolve(values["lock-file"] as string);
} else if (values.lock) {
  env.URL_IMPORT_LOCK = resolve("deno.lock");
}
if (values.frozen) {
  env.URL_IMPORT_FROZEN = "1";
  if (!env.URL_IMPORT_LOCK) {
    env.URL_IMPORT_LOCK = resolve("deno.lock");
  }
}

const result = spawnSync(process.execPath, nodeArgs, {
  stdio: "inherit",
  env,
});

process.exit(result.status ?? 1);
