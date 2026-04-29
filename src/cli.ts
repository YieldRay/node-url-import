#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseArgs, styleText } from "node:util";
import { NAME, isHttpUrl } from "./constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h", default: false },
    "clear-cache": { type: "boolean", default: false },
    "local-meta": { type: "boolean", default: false },
    reload: { type: "boolean", short: "r", default: false },
    lock: { type: "boolean", default: false },
    "lock-file": { type: "string" },
    frozen: { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: true,
});

if (values.help || (positionals.length === 0 && !values["clear-cache"])) {
  const dim = (s: string) => styleText("dim", s);
  const y = (s: string) => styleText("yellow", s);
  const c = (s: string) => styleText("cyan", s);
  const b = (s: string) => styleText("bold", s);
  // Column for descriptions aligns at character 24
  console.log(`
${b(NAME)} ${dim("—")} run Node.js scripts that import from HTTP(S) URLs

${b("Usage:")}
  ${c(NAME)} ${dim("[options]")} ${dim("<script-or-url>")} ${dim("[args...]")}
  ${c(NAME)} ${y("--clear-cache")}

${b("Examples:")}
  ${dim("$")} ${c(NAME)} ./app.mjs
  ${dim("$")} ${c(NAME)} https://esm.sh/dler
  ${dim("$")} ${c(NAME)} ${y("-r")} ./app.mjs           ${dim("# reload all remote modules")}
  ${dim("$")} ${c(NAME)} ${y("--lock")} ./app.mjs       ${dim("# check/write deno.lock")}
  ${dim("$")} node ${y("--import")} ${NAME}/register ./app.mjs
  ${dim("$")} node ${y("--loader")} ${NAME}/loader ./app.mjs

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
  ${y("URL_IMPORT_META=file")}     Same as --local-meta
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

const target: string = positionals[0]!;
const restArgs: string[] = positionals.slice(1);

const registerPath: string = resolve(__dirname, "register.ts");

const nodeVersion: number[] = process.versions.node.split(".").map(Number);
const supportsImport: boolean =
  nodeVersion[0]! > 20 ||
  (nodeVersion[0] === 20 && nodeVersion[1]! >= 6) ||
  (nodeVersion[0] === 18 && nodeVersion[1]! >= 19);

let nodeArgs: string[];

if (isHttpUrl(target)) {
  const evalScript = `import ${JSON.stringify(target)};`;

  if (supportsImport) {
    nodeArgs = [
      "--import", registerPath,
      "--input-type=module",
      "-e", evalScript,
      ...restArgs,
    ];
  } else {
    const loaderPath = resolve(__dirname, "loader.ts");
    nodeArgs = [
      "--loader", loaderPath,
      "--input-type=module",
      "-e", evalScript,
      ...restArgs,
    ];
  }
} else {
  if (supportsImport) {
    nodeArgs = ["--import", registerPath, target, ...restArgs];
  } else {
    const loaderPath = resolve(__dirname, "loader.ts");
    nodeArgs = ["--experimental-loader", loaderPath, target, ...restArgs];
  }
}

// Pass flags to the child process via environment variables.
const env: Record<string, string | undefined> = { ...process.env };

if (values["local-meta"]) {
  env.URL_IMPORT_META = "file";
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
