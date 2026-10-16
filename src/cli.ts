#!/usr/bin/env node

import process from "node:process";
import { spawn } from "node:child_process";
import { constants as osConstants, platform } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CDN, NAME, isHttpUrl } from "./constants.ts";
import { clearCache } from "./cache.ts";
import { styleText } from "./style-text.ts";

// Resolve the preload path without registering hooks in the wrapper process.
const registerImportMetaUrl = new URL(import.meta.url.endsWith(".ts") ? "./register-hooks.ts" : "./register-hooks.js", import.meta.url).href;

const ownOptions = {
  help: { type: "boolean", short: "h" },
  "clear-cache": { type: "boolean" },
  tmp: { type: "boolean" },
  reload: { type: "boolean" },
  lock: { type: "boolean" },
  "lock-file": { type: "string" },
  frozen: { type: "boolean" },
  cdn: { type: "boolean" },
} as const;

/**
 * Consume only the leading options belonging to this CLI. Once Node's arguments
 * start, leave the entire remainder untouched: only Node knows their grammar.
 */
function consumeOptions(args: string[]) {
  const ownArgs: string[] = [];
  const ownNames = new Set<string>(Object.keys(ownOptions).map((name) => `--${name}`));
  ownNames.add("-h");
  let customCdn: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? undefined : argument.slice(separator + 1);
    if (ownNames.has(name)) {
      if (name === "--cdn" && value !== undefined) {
        customCdn = value;
        ownArgs.push("--cdn");
      } else {
        if (name === "--cdn") customCdn = undefined;
        ownArgs.push(argument);
        if (name === "--lock-file" && value === undefined) {
          const next = args[++index];
          if (!next || next.startsWith("-")) throw new TypeError(`${name} requires a path`);
          ownArgs.push(next);
        }
      }
    } else {
      return { ownArgs, nodeArgs: args.slice(index), customCdn };
    }
  }
  return { ownArgs, nodeArgs: [], customCdn };
}

const { ownArgs, nodeArgs, customCdn } = consumeOptions(process.argv.slice(2));
const { values } = parseArgs({ args: ownArgs, options: ownOptions, strict: true });
const cdnBase = values.cdn ? customCdn ?? DEFAULT_CDN : undefined;

// No entry is required: Node can evaluate code, read stdin, or start its REPL.
if (values.help) {
  const dim = (s: string) => styleText("dim", s);
  const y = (s: string) => styleText("yellow", s);
  const c = (s: string) => styleText("cyan", s);
  const b = (s: string) => styleText("bold", s);

  const defaultCacheRoot = platform() === "darwin" ? "~/Library/Caches/deno" : platform() === "win32" ? "%LOCALAPPDATA%\\deno" : "~/.cache/deno";
  console.log(`
${b(NAME)} ${dim("—")} run Node.js scripts that import from HTTP(S) URLs

${b("Usage:")}
  ${c(NAME)} ${dim("[options]")} ${dim("[node-flags]")} ${dim("[script-or-url]")} ${dim("[script-args...]")}
  ${c(NAME)} ${y("--clear-cache")}

  Put ${NAME} options first; the remaining arguments are passed to Node.js as-is.
  Node.js handles its own flags, execution modes, and script arguments.

${b("Examples:")}
  ${dim("$")} ${c(NAME)} ./app.mjs
  ${dim("$")} ${c(NAME)} https://raw.esm.sh/armor64/dist/cli.js
  ${dim("$")} ${c(NAME)} ${y("--reload")} ./app.mjs            ${dim("# reload remote modules")}
  ${dim("$")} ${c(NAME)} ${y("--lock")} ./app.mjs              ${dim("# check/write deno.lock")}
  ${dim("$")} ${c(NAME)} ${y("--inspect")} ./app.mjs           ${dim("# pass --inspect to node")}
  ${dim("$")} ${c(NAME)} https://example.com/cli.js -h ${dim("# -h forwarded to script")}

${b("Options:")}
  ${y("--reload")}                 Bypass cache, re-fetch all remote modules
  ${y("--lock")}                   Check/write a lock file ${dim("(default: ./deno.lock)")}
  ${y("--lock-file")} ${dim("<path>")}       Lock file path ${dim("(implies --lock)")}
  ${y("--frozen")}                 Error if lock file is out of date ${dim("(use with --lock)")}
  ${y("--tmp")}                    Write fetched modules to a tmp dir with readable paths
                          ${dim("(modules see themselves as local files under /tmp/node-url-import/)")}
  ${y("--cdn")}${dim("[=<url>]")}            Resolve missing bare packages via a CDN ${dim(`(e.g. ws → ${DEFAULT_CDN}ws)`)}
                          ${dim(`(default: ${DEFAULT_CDN}; node_modules first)`)}

${b("Environment:")}
  ${y("DENO_DIR")}                 Deno cache root ${dim(`(default: ${defaultCacheRoot})`)}
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

// Pass our flags to the child process via environment variables.
const env: Record<string, string | undefined> = { ...process.env };

// Let Node choose the entry, then recover its exact URL during registration.
// Keep candidate positions and separators, not a second parser for Node flags.
delete env.URL_IMPORT_MAIN;
delete env.URL_IMPORT_MAIN_CANDIDATES;
const mainCandidates: Record<string, string> = {};
for (let index = 0; index < nodeArgs.length; index++) {
  const argument = nodeArgs[index]!;
  if (isHttpUrl(argument) || argument === "--") mainCandidates[index] = argument;
}
if (Object.keys(mainCandidates).length) env.URL_IMPORT_MAIN_CANDIDATES = JSON.stringify(mainCandidates);
for (const [option, variable] of [["tmp", "URL_IMPORT_TMP"], ["reload", "URL_IMPORT_RELOAD"], ["frozen", "URL_IMPORT_FROZEN"]] as const) {
  if (values[option]) env[variable] = "1";
}
if (values["lock-file"]) {
  env.URL_IMPORT_LOCK = resolve(values["lock-file"]);
} else if (values.lock) {
  env.URL_IMPORT_LOCK = resolve("deno.lock");
}
if (values.frozen && !env.URL_IMPORT_LOCK) env.URL_IMPORT_LOCK = resolve("deno.lock");
if (cdnBase) {
  const parsed = new URL(cdnBase);
  if (!isHttpUrl(parsed.href) || parsed.search || parsed.hash) throw new TypeError("The CDN base must be an HTTP(S) URL without query or fragment");
  env.URL_IMPORT_CDN = parsed.href.endsWith("/") ? parsed.href : parsed.href + "/";
}

const child = spawn(process.execPath, ["--import", registerImportMetaUrl, ...nodeArgs], {
  stdio: "inherit",
  env,
});

// Keep the wrapper responsive to process-manager and terminal signals while
// Node runs. A target may handle a signal and exit normally; wait for its result.
const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] as const : ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
const signalHandlers = new Map<NodeJS.Signals, () => void>();
for (const signal of signals) {
  const forward = (): void => { child.kill(signal); };
  signalHandlers.set(signal, forward);
  process.on(signal, forward);
}

child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  for (const [name, handler] of signalHandlers) process.removeListener(name, handler);
  if (signal && process.platform !== "win32") {
    // Re-raise after removing our handlers so callers observe the same signal.
    process.kill(process.pid, signal);
  } else {
    process.exitCode = signal ? 128 + osConstants.signals[signal] : code ?? 1;
  }
});
