import utils from "node:util";

/**
 * ANSI escape codes mapping
 */
const styles = {
  // Reset
  reset: "\x1b[0m",

  // Text styles
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  strikethrough: "\x1b[9m",

  // Text colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  grey: "\x1b[90m",

  // Bright text colors
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",

  // Background colors
  bgBlack: "\x1b[40m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgWhite: "\x1b[47m",
};

type Format = keyof typeof styles;

export const styleText = utils.styleText || _styleText;

/**
 * Basic implementation of util.styleText for formatting text with ANSI colors
 * @param format - A text format or an Array of text formats
 * @param - The text to be formatted
 * @returns The formatted text with ANSI escape codes
 */
function _styleText(format: Format | Format[], text: string) {
  const formats = Array.isArray(format) ? format : [format];
  // Build the opening escape sequences
  let openCodes = "";
  for (const fmt of formats) if (fmt in styles) openCodes += styles[fmt];
  // Return formatted text with reset at the end
  return openCodes + text + styles.reset;
}
