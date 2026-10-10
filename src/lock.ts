/**
 * Deno lock v5 support: source hashes and hop-by-hop redirect records.
 * Enabled only by URL_IMPORT_LOCK; frozen mode rejects missing or changed
 * records. Unrelated npm, jsr and workspace sections are preserved on writes.
 */

import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomicSync } from "./cache.ts";
import type { CacheEntry, ModuleSource } from "./cache.ts";
import { MAX_REDIRECTS, isHttpUrl } from "./constants.ts";

const LOCK_VERSION = "5";
const lockPath = process.env.URL_IMPORT_LOCK ? resolve(process.env.URL_IMPORT_LOCK) : null;
// As in Deno --no-lock, frozen has no effect unless a lock file is enabled.
const frozen = lockPath !== null && process.env.URL_IMPORT_FROZEN === "1";
const lockWait = new Int32Array(new SharedArrayBuffer(4));

interface LockFileData {
  version: string;
  redirects: Record<string, string>;
  remote: Record<string, string>;
  [key: string]: unknown;
}

export function hashSource(source: ModuleSource): string {
  return createHash("sha256").update(source).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function loadLockFile(path: string): LockFileData {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { version: LOCK_VERSION, redirects: {}, remote: {} };
    }
    throw error;
  }
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || (data.version !== undefined && typeof data.version !== "string") ||
    (data.redirects !== undefined && !isStringRecord(data.redirects)) ||
    (data.remote !== undefined && !isStringRecord(data.remote))) {
    throw new Error(`Invalid lock file: ${path}`);
  }
  return {
    ...data,
    version: typeof data.version === "string" ? data.version : LOCK_VERSION,
    redirects: isStringRecord(data.redirects) ? data.redirects : {},
    remote: isStringRecord(data.remote) ? data.remote : {},
  };
}

/** Only reclaim a known owner after its process has exited; never steal a live lock. */
function removeDeadOwner(directory: string): void {
  try {
    const owners = readdirSync(directory);
    if (owners.length !== 1) return;
    const owner = owners[0]!;
    const match = /^owner-(\d+)-/.exec(owner);
    if (!match) return;
    try {
      process.kill(Number(match[1]), 0);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return;
    }
    // Unlink the specific owner first. Competing reclaimers cannot then remove
    // a newly acquired directory because only one can unlink this owner file.
    unlinkSync(join(directory, owner));
    rmdirSync(directory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTEMPTY"))) throw error;
  }
}

/**
 * mkdir is the cross-process exclusion point. The transaction contains only
 * synchronous filesystem operations, so a worker cannot yield while owning it.
 * A bounded wait also reports abandoned empty locks instead of hanging forever.
 */
function acquireLock(path: string): () => void {
  const directory = `${path}.lock`;
  const owner = join(directory, `owner-${process.pid}-${randomUUID()}`);
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      mkdirSync(directory, { mode: 0o700 });
      try {
        writeFileSync(owner, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        rmdirSync(directory);
        throw error;
      }
      return () => {
        unlinkSync(owner);
        rmdirSync(directory);
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting to update lock file ${path}`);
      removeDeadOwner(directory);
      Atomics.wait(lockWait, 0, 0, 10);
    }
  }
}

function canonicalLockPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return join(realpathSync(dirname(path)), basename(path));
  }
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]!]));
}

/** Reload inside the filesystem lock so main-thread and worker snapshots cannot diverge. */
function updateLock(update: (data: LockFileData) => void): void {
  if (!lockPath) return;
  if (frozen) {
    update(loadLockFile(lockPath));
    return;
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  // Deno follows lockfile symlinks. All aliases must lock, read and replace the
  // same target, not independently lock the names of their symlinks.
  const target = canonicalLockPath(lockPath);
  const release = acquireLock(target);
  try {
    const data = loadLockFile(target);
    const previous = JSON.stringify(data);
    update(data);
    if (JSON.stringify(data) !== previous) {
      const { version, redirects, remote, ...preserved } = data;
      const output = {
        version,
        ...(Object.keys(redirects).length ? { redirects: sortedRecord(redirects) } : {}),
        ...(Object.keys(remote).length ? { remote: sortedRecord(remote) } : {}),
        ...preserved,
      };
      writeFileAtomicSync(target, JSON.stringify(output, null, 2) + "\n");
    }
  } finally {
    release();
  }
}

function requireMutableLock(): void {
  if (frozen) throw new Error("The lockfile is out of date. Rerun without --frozen and with URL_IMPORT_FROZEN=0 to update it.");
}

function normalizeUrl(url: string): string {
  return new URL(url).href;
}

/** Deno seeds its module graph with recorded redirects, even when reloading. */
export function resolveLockRedirects(url: string): string[] {
  const chain = [normalizeUrl(url)];
  if (!lockPath) return chain;
  const { redirects } = loadLockFile(lockPath);
  while (true) {
    const target = redirects[chain.at(-1)!];
    if (target === undefined) return chain;
    if (chain.length > MAX_REDIRECTS) throw new Error(`Too many locked redirects for ${url}`);
    const normalized = normalizeUrl(target);
    if (!isHttpUrl(normalized)) throw new TypeError(`Unsupported locked redirect URL: ${normalized}`);
    if (chain.includes(normalized)) throw new Error(`Circular locked redirect for ${url}`);
    chain.push(normalized);
  }
}

function verifySource(data: LockFileData, url: string, source: ModuleSource): void {
  const key = normalizeUrl(url);
  const actual = hashSource(source);
  const expected = data.remote[key];
  if (expected !== undefined && expected !== actual) {
    throw new Error(`Integrity check failed for ${key}\nActual: ${actual}\nExpected: ${expected}`);
  }
  if (expected === undefined) {
    requireMutableLock();
    data.remote[key] = actual;
  }
}

function verifyRedirect(data: LockFileData, from: string, to: string): void {
  const source = normalizeUrl(from);
  const target = normalizeUrl(to);
  const expected = data.redirects[source];
  if (source === target) {
    if (expected !== undefined) {
      requireMutableLock();
      delete data.redirects[source];
    }
  } else if (expected !== target) {
    requireMutableLock();
    data.redirects[source] = target;
  }
}

export function isLockEnabled(): boolean {
  return lockPath !== null;
}

/** Verify a fetched module's source against its recorded SHA-256 hash. */
export function verifyLock(url: string, source: ModuleSource): void {
  updateLock((data) => verifySource(data, url, source));
}

/** Record or verify one redirect hop, keeping Deno's original-to-next layout. */
export function recordRedirect(from: string, to: string): void {
  updateLock((data) => verifyRedirect(data, from, to));
}

/** Check the source and every redirect as one transaction before publishing a cache entry. */
export function verifyModuleLock(entry: CacheEntry): void {
  updateLock((data) => {
    verifySource(data, entry.finalUrl, entry.source);
    for (let index = 0; index < entry.redirectChain.length - 1; index++) {
      verifyRedirect(data, entry.redirectChain[index]!, entry.redirectChain[index + 1]!);
    }
    verifyRedirect(data, entry.finalUrl, entry.finalUrl);
  });
}
