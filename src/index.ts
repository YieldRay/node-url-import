export * from "./add.ts";

/**
 * Run the CLI when the module is the main module
 *
 * import.meta.main
 * @see https://exploringjs.com/nodejs-shell-scripting/ch_nodejs-path.html#detecting-if-module-is-main
 */
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
if (import.meta.url.startsWith("file:")) {
  const modulePath = fileURLToPath(import.meta.url);
  if (argv[1] === modulePath) {
    await import("./cli.ts");
  }
}
