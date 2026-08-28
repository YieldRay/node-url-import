/**
 * JSR specifier support (`jsr:@scope/pkg[@version][/subpath]`).
 *
 * Rather than talking to the JSR registry directly, specifiers are rewritten
 * to esm.sh's `/jsr/` endpoint, which resolves versions and ranges,
 * transpiles TypeScript, and rewrites transitive dependencies to esm.sh
 * URLs itself:
 *
 *   jsr:@std/encoding@1.0.0/base64 → https://esm.sh/jsr/@std/encoding@1.0.0/base64
 *   jsr:@hono/hono@4               → https://esm.sh/jsr/@hono/hono@4
 *
 * The feature is only enabled when --cdn points at esm.sh (the default
 * CDN). From there on, mapped URLs flow through the regular HTTP module
 * pipeline (disk cache, lock file, redirects).
 */

/**
 * Whether the --cdn base URL is esm.sh — the only CDN with a /jsr/
 * endpoint, so the only one jsr: specifiers can be mapped to.
 * The CDN base always carries a trailing slash (see cli.ts).
 */
export function isEsmShCdn(cdnBase: string): boolean {
  return cdnBase.startsWith("https://esm.sh/");
}

/** jsr:@<scope>/<name>[@<version>][/<subpath>] — scopes/names are lowercase alnum + dashes. */
const JSR_SPECIFIER_RE =
  /^jsr:@([a-z0-9-]+)\/([a-z0-9-]+?)(?:@([^/]+))?(?:\/(.+))?$/;

/**
 * Validate a `jsr:` specifier's shape.
 * @throws If it doesn't match `jsr:@<scope>/<name>[@<version>][/<subpath>]`.
 */
export function parseJsrSpecifier(specifier: string): void {
  if (!JSR_SPECIFIER_RE.test(specifier)) {
    throw new Error(
      `Invalid JSR specifier "${specifier}". ` +
        `Expected jsr:@<scope>/<name>[@<version>][/<subpath>], e.g. jsr:@std/uuid@1.0.1/v1.`,
    );
  }
}

/**
 * Rewrite a `jsr:` specifier to its esm.sh `/jsr/` URL.
 * `cdnBase` must be an esm.sh base URL with a trailing slash.
 * The version slot is passed through verbatim — esm.sh resolves exact
 * versions and ranges (`@1.0.1`, `@4`, `@^1.0.6`) server-side.
 */
export function jsrToCdnUrl(specifier: string, cdnBase: string): string {
  parseJsrSpecifier(specifier);
  return `${cdnBase}jsr/${specifier.slice(4)}`;
}
