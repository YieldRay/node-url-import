#!/usr/bin/env node

import process from "node:process";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, styleText } from "node:util";
import { DEFAULT_CDN, NAME, isHttpUrl } from "./constants.ts";
import { clearCache } from "./cache.ts";

// Resolve the preload path without registering hooks in the wrapper process.
const registerImportMetaUrl = new URL(import.meta.url.endsWith(".ts") ? "./register-hooks.ts" : "./register-hooks.js", import.meta.url).href;

const ownOptions = {
  help: { type: "boolean", short: "h" },
  "clear-cache": { type: "boolean" },
  tmp: { type: "boolean" },
  reload: { type: "boolean", short: "r" },
  lock: { type: "boolean" },
  "lock-file": { type: "string" },
  frozen: { type: "boolean" },
  cdn: { type: "boolean" },
} as const;

/**
 * Node describes required values as --flag=... in its own help output.
 * Inspect the running version rather than maintaining a stale list of flags;
 * --inspect[=...] remains optional and must not consume the script positional.
 */
function nodeValueOptions(): Set<string> {
  const help = spawnSync(process.execPath, ["--help"], {
    encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" },
  });
  if (help.status !== 0) throw help.error ?? new Error("Unable to inspect Node command-line options");
  const names = new Set<string>();
  for (const line of help.stdout.split("\n")) {
    const declaration = line.match(/^  ((?:--?[\w-]+(?:=[^\s,]+)?)(?:, --?[\w-]+(?:=[^\s,]+)?)*)/);
    if (!declaration || !declaration[1]!.includes("=") || declaration[1]!.includes("[=")) continue;
    for (const name of declaration[1]!.split(", ")) names.add(name.split("=")[0]!);
  }
  return names;
}

/**
 * node-url-import [our-flags] [node-flags] <script-or-url> [script-args]
 * Stop parsing at the target: later arguments belong exclusively to the script.
 * Required Node values are consumed before searching for that target.
 */
function splitArguments(args: string[]) {
  const ownArgs: string[] = [];
  const nodeFlags: string[] = [];
  const ownNames = new Set<string>(Object.keys(ownOptions).map((name) => `--${name}`));
  ownNames.add("-r");
  ownNames.add("-h");
  let requiredNodeValues: Set<string> | undefined;
  let customCdn: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") return { ownArgs, nodeFlags, customCdn, target: args[index + 1], scriptArgs: args.slice(index + 2) };
    if (argument === "-" || !argument.startsWith("-")) {
      return { ownArgs, nodeFlags, customCdn, target: argument, scriptArgs: args.slice(index + 1) };
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? undefined : argument.slice(separator + 1);
    if (ownNames.has(name)) {
      if (name === "--cdn" && (value === undefined || value === "true" || value === "false")) customCdn = undefined;
      if (name === "--cdn" && value !== undefined && value !== "true" && value !== "false") {
        customCdn = value;
        ownArgs.push("--cdn");
      } else if (name !== "--lock-file" && value !== undefined) {
        if (value !== "true" && value !== "false") throw new TypeError(`Invalid boolean option: ${argument}`);
        const canonicalName = name === "-r" ? "reload" : name === "-h" ? "help" : name.slice(2);
        ownArgs.push(value === "true" ? `--${canonicalName}` : `--no-${canonicalName}`);
      } else {
        ownArgs.push(argument);
        if (name === "--lock-file" && value === undefined) {
          const next = args[++index];
          if (!next || next.startsWith("-")) throw new TypeError(`${name} requires a path`);
          ownArgs.push(next);
        }
      }
    } else if (name.startsWith("--no-") && ownNames.has(`--${name.slice(5)}`)) {
      if (name === "--no-cdn") customCdn = undefined;
      ownArgs.push(argument);
    } else {
      nodeFlags.push(argument);
      if (value === undefined && (requiredNodeValues ??= nodeValueOptions()).has(name)) {
        const next = args[++index];
        if (next === undefined) throw new TypeError(`${name} requires a value`);
        nodeFlags.push(next);
      }
    }
  }
  return { ownArgs, nodeFlags, customCdn, target: undefined, scriptArgs: [] };
}

const { ownArgs, nodeFlags, customCdn, target, scriptArgs } = splitArguments(process.argv.slice(2));
const { values } = parseArgs({ args: ownArgs, options: ownOptions, strict: true, allowNegative: true });
const cdnBase = values.cdn ? customCdn ?? DEFAULT_CDN : undefined;

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
  ${dim("$")} ${c(NAME)} https://raw.esm.sh/armor64/dist/cli.js
  ${dim("$")} ${c(NAME)} ${y("-r")} ./app.mjs                  ${dim("# reload remote modules")}
  ${dim("$")} ${c(NAME)} ${y("--lock")} ./app.mjs              ${dim("# check/write deno.lock")}
  ${dim("$")} ${c(NAME)} ${y("--inspect")} ./app.mjs           ${dim("# pass --inspect to node")}
  ${dim("$")} ${c(NAME)} https://example.com/cli.js -h ${dim("# -h forwarded to script")}

${b("Options:")}
  ${y("-r, --reload")}             Bypass cache, re-fetch all remote modules
  ${y("--lock")}                   Check/write a lock file ${dim("(default: ./deno.lock)")}
  ${y("--lock-file")} ${dim("<path>")}       Lock file path ${dim("(implies --lock)")}
  ${y("--frozen")}                 Error if lock file is out of date ${dim("(use with --lock)")}
  ${y("--tmp")}                    Write fetched modules to a tmp dir with readable paths
                          ${dim("(modules see themselves as local files under /tmp/node-url-import/)")}
  ${y("--cdn")}${dim("[=<url>]")}            Resolve bare specifiers via a CDN ${dim(`(e.g. ws → ${DEFAULT_CDN}ws)`)}
                          ${dim(`(default: ${DEFAULT_CDN}; node built-ins stay local)`)}

${b("Environment:")}
  ${y("DENO_DIR")}                 Deno cache root ${dim("(default: ~/Library/Caches/deno on macOS, ~/.cache/deno on Linux)")}
  ${y("URL_IMPORT_TMP=1")}         Same as --tmp
  ${y("URL_IMPORT_RELOAD=1")}      Same as --reload
  ${y("URL_IMPORT_LOCK")}${dim("=path")}     Same as --lock <file>
  ${y("URL_IMPORT_FROZEN=1")}      Same as --frozen
  ${y("URL_IMPORT_CDN")}${dim("=<url>")}     Same as --cdn=<url>
`);
  process.exit(0);
}

if (values["clear-cache"]) {
  clearCache();
  console.log(`${styleText("green", "✓")} Cache cleared.`);
  process.exit(0);
}

// Use the registration file as a guaranteed placeholder for HTTP entries.
// URL_IMPORT_MAIN redirects it in resolve, preserving import.meta.main.
const remoteTarget = isHttpUrl(target!);
const entry = remoteTarget ? fileURLToPath(registerImportMetaUrl) : target!;
// The separator belongs before the entry so flag-like filenames are safe;
// script arguments remain after the entry and receive no extra separator.
const nodeArgs = ["--import", registerImportMetaUrl, ...nodeFlags, "--", entry, ...scriptArgs];

// Pass our flags to the child process via environment variables.
const env: Record<string, string | undefined> = { ...process.env };

// A nested CLI invocation must not accidentally execute its parent's remote entry.
delete env.URL_IMPORT_MAIN;
if (remoteTarget) env.URL_IMPORT_MAIN = target;
for (const [option, variable] of [["tmp", "URL_IMPORT_TMP"], ["reload", "URL_IMPORT_RELOAD"], ["frozen", "URL_IMPORT_FROZEN"]] as const) {
  if (values[option] !== undefined) env[variable] = values[option] ? "1" : "0";
}
if (values["lock-file"]) {
  env.URL_IMPORT_LOCK = resolve(values["lock-file"]);
} else if (values.lock) {
  env.URL_IMPORT_LOCK = resolve("deno.lock");
} else if (values.lock === false) {
  delete env.URL_IMPORT_LOCK;
}
if (env.URL_IMPORT_FROZEN === "1" && !env.URL_IMPORT_LOCK) env.URL_IMPORT_LOCK = resolve("deno.lock");
if (cdnBase) {
  const parsed = new URL(cdnBase);
  if (!isHttpUrl(parsed.href) || parsed.search || parsed.hash) throw new TypeError("The CDN base must be an HTTP(S) URL without query or fragment");
  env.URL_IMPORT_CDN = parsed.href.endsWith("/") ? parsed.href : parsed.href + "/";
} else if (values.cdn === false) {
  delete env.URL_IMPORT_CDN;
}

const result = spawnSync(process.execPath, nodeArgs, {
  stdio: "inherit",
  env,
});

process.exit(result.status ?? 1);
