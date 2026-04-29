/**
 * Lock file support for node-url-import.
 *
 * Uses the same format as Deno's lock file:
 * {
 *   "version": "5",
 *   "remote": {
 *     "https://esm.sh/lodash-es@4.17.21": "<sha256-hex>"
 *   }
 * }
 *
 * The lock file is only read/written when explicitly enabled via --lock.
 * With --frozen, any missing or mismatched entry causes an error.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const LOCK_VERSION = "5";

interface LockFileData {
  version: string;
  remote: Record<string, string>;
}

const lockPath: string | null = process.env.URL_IMPORT_LOCK || null;
const frozen: boolean = process.env.URL_IMPORT_FROZEN === "1";

let lockData: LockFileData | null = null;
let dirty = false;

export function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function loadLockFile(): Promise<LockFileData> {
  if (lockData) return lockData;

  if (lockPath && existsSync(lockPath)) {
    try {
      const raw = await readFile(lockPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.remote === "object") {
        lockData = {
          version: parsed.version || LOCK_VERSION,
          remote: parsed.remote,
        };
      } else {
        lockData = { version: LOCK_VERSION, remote: {} };
      }
    } catch {
      lockData = { version: LOCK_VERSION, remote: {} };
    }
  } else {
    lockData = { version: LOCK_VERSION, remote: {} };
  }

  return lockData;
}

async function flushLockFile(): Promise<void> {
  if (!lockPath || !dirty || !lockData) return;
  const json = JSON.stringify(lockData, null, 2) + "\n";
  await writeFile(lockPath, json, "utf-8");
  dirty = false;
}

export function isLockEnabled(): boolean {
  return lockPath !== null;
}

export async function verifyLock(url: string, source: string): Promise<void> {
  if (!lockPath) return;

  const data = await loadLockFile();
  const hash = hashSource(source);
  const existing = data.remote[url];

  if (existing) {
    if (existing !== hash) {
      throw new Error(
        `Lock file integrity check failed for ${url}\n` +
          `  expected: ${existing}\n` +
          `  got:      ${hash}\n` +
          `  Run with --reload to update the cache, or remove the lock file.`,
      );
    }
    return;
  }

  if (frozen) {
    throw new Error(
      `Lock file is frozen but ${url} is not recorded.\n` +
        `  Run without --frozen to update the lock file.`,
    );
  }

  data.remote[url] = hash;
  dirty = true;
  await flushLockFile();
}
