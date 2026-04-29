#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
import { parseArgs } from "node:util";
import process from "node:process";
import { styleText, inspect, debuglog } from "node:util";
import pkg from "../package.json" with { type: "json" };

const log = debuglog(pkg.name);

// https://nodejs.org/api/util.html#utilparseargsconfig
const { values, positionals } = parseArgs({
  options: {
    help: {
      type: "boolean",
      multiple: false,
      short: "h",
      default: false,
    },
    lhs: {
      type: "string",
      short: "a",
      default: "0",
    },
    rhs: {
      type: "string",
      short: "b",
      default: "0",
    },
  },
  strict: true,
  allowPositionals: true,
});

log("parseArgs", values, positionals);

if (positionals.length < 1 || values.help) {
  help();
}

const command = positionals[0];

switch (command) {
  case "help":
    help();
    break;
  case "add":
    const { lhs, rhs } = values;
    const sum = Number.parseFloat(lhs) + Number.parseFloat(rhs);
    console.log("%s + %s = %s", lhs, rhs, sum);
    break;
  case "env":
    process.loadEnvFile(positionals[1]);
    process.stdout.write(inspect(process.env));
    break;
  default:
    process.stderr.write(`Unknown command ${command}\n`);
    process.exit(1);
}

function help() {
  process.stdout.write(`${styleText("green", pkg.name)} v${pkg.version}

  A typescript nodejs template with minimal dependencies

  ${styleText("bold", "Usage:")}

  cli-name add --lhs [number] --rhs [number]    Get sum of lhs and rhs
  cli-name help                                 Show this help
`);
  process.exit(1);
}
