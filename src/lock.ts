/**
 * Lock file support for node-url-import.
 *
 * Uses the same format as Deno's lock file:
 * {
 *   "version": "5",
 *   "redirects": {
 *     "https://raw.esm.sh/armor64/dist/cli.js": "https://raw.esm.sh/armor64@0.1.0/dist/cli.js"
 *   },
 *   "remote": {
 *     "https://raw.esm.sh/armor64@0.1.0/dist/cli.js": "<sha256-hex>"
 *   }
 * }
 *
 * The lock file is only read/written when explicitly enabled via --lock.
 * With --frozen, any missing or mismatched entry causes an error.
 */

import process from "node:process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { ModuleSource } from "./cache.ts";

const LOCK_VERSION = "5";

interface LockFileData {
  version: string;
  redirects: Record<string, string>;
  remote: Record<string, string>;
}

const lockPath: string | null = process.env.URL_IMPORT_LOCK || null;
const frozen: boolean = process.env.URL_IMPORT_FROZEN === "1";

let lockData: LockFileData | null = null;
let dirty = false;

export function hashSource(source: ModuleSource): string {
  return createHash("sha256").update(source).digest("hex");
}

function loadLockFile(): LockFileData {
  if (lockData) return lockData;

  if (lockPath && existsSync(lockPath)) {
    try {
      const raw = readFileSync(lockPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.remote === "object") {
        lockData = {
          version: parsed.version || LOCK_VERSION,
          redirects: parsed.redirects || {},
          remote: parsed.remote,
        };
      } else {
        lockData = { version: LOCK_VERSION, redirects: {}, remote: {} };
      }
    } catch {
      lockData = { version: LOCK_VERSION, redirects: {}, remote: {} };
    }
  } else {
    lockData = { version: LOCK_VERSION, redirects: {}, remote: {} };
  }

  return lockData;
}

function flushLockFile(): void {
  if (!lockPath || !dirty || !lockData) return;
  // Output sections in Deno's order: version, redirects (if non-empty), remote
  const out: Record<string, unknown> = { version: lockData.version };
  if (Object.keys(lockData.redirects).length > 0) {
    out.redirects = lockData.redirects;
  }
  out.remote = lockData.remote;
  const json = JSON.stringify(out, null, 2) + "\n";
  writeFileSync(lockPath, json, "utf-8");
  dirty = false;
}

export function isLockEnabled(): boolean {
  return lockPath !== null;
}

/**
 * Record a redirect in the lock file (original URL → final URL).
 * Only records when they differ.
 */
export function recordRedirect(from: string, to: string): void {
  if (!lockPath || from === to) return;

  const data = loadLockFile();
  const existing = data.redirects[from];

  if (existing === to) return;

  if (frozen) {
    throw new Error(
      `The lockfile is out of date. Rerun with \`--frozen=false\` to update it.`,
    );
  }

  data.redirects[from] = to;
  dirty = true;
  flushLockFile();
}

/**
 * Verify a fetched module's source against the lock file.
 */
export function verifyLock(url: string, source: ModuleSource): void {
  if (!lockPath) return;

  const data = loadLockFile();
  const hash = hashSource(source);
  const existing = data.remote[url];

  if (existing) {
    if (existing !== hash) {
      throw new Error(
        `Integrity check failed for remote specifier. The source code is invalid, as it does not match the expected hash in the lock file.\n` +
          `\n` +
          `  Specifier: ${url}\n` +
          `  Actual: ${hash}\n` +
          `  Expected: ${existing}\n` +
          `\n` +
          `This could be caused by:\n` +
          `  * the lock file may be corrupt\n` +
          `  * the source itself may be corrupt\n` +
          `\n` +
          `Investigate the lockfile; delete it to regenerate the lockfile or --reload to reload the source code from the server.`,
      );
    }
    return;
  }

  if (frozen) {
    throw new Error(
      `The lockfile is out of date. Rerun with \`--frozen=false\` to update it.`,
    );
  }

  data.remote[url] = hash;
  dirty = true;
  flushLockFile();
}
