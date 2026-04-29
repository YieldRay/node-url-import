import process from "node:process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { NAME } from "./constants.ts";

const CACHE_DIR =
  process.env.URL_IMPORT_CACHE_DIR || join(homedir(), ".cache", NAME);

export interface CachePaths {
  dir: string;
  file: string;
  meta: string;
}

export interface CacheEntry {
  source: string;
  contentType: string;
  url: string;
  finalUrl: string;
}

interface CacheMeta {
  url: string;
  finalUrl: string;
  contentType: string;
  cachedAt: number;
}

export function cachePaths(url: string): CachePaths {
  const parsed = new URL(url);
  const hash = createHash("sha256").update(url).digest("hex");
  const dir = join(CACHE_DIR, parsed.hostname);
  return {
    dir,
    file: join(dir, hash),
    meta: join(dir, hash + ".meta.json"),
  };
}

export async function readCache(url: string): Promise<CacheEntry | null> {
  const { file, meta } = cachePaths(url);
  if (!existsSync(file) || !existsSync(meta)) return null;
  try {
    const [source, raw] = await Promise.all([
      readFile(file, "utf-8"),
      readFile(meta, "utf-8"),
    ]);
    const metadata: CacheMeta = JSON.parse(raw);
    return {
      source,
      contentType: metadata.contentType,
      url: metadata.url,
      finalUrl: metadata.finalUrl || metadata.url,
    };
  } catch {
    return null;
  }
}

export async function writeCache(
  url: string,
  source: string,
  contentType: string,
  finalUrl?: string,
): Promise<void> {
  const { dir, file, meta } = cachePaths(url);
  await mkdir(dir, { recursive: true });
  const metadata: CacheMeta = {
    url,
    finalUrl: finalUrl || url,
    contentType,
    cachedAt: Date.now(),
  };
  await Promise.all([
    writeFile(file, source, "utf-8"),
    writeFile(meta, JSON.stringify(metadata), "utf-8"),
  ]);
}

export async function clearCache(): Promise<void> {
  await rm(CACHE_DIR, { recursive: true, force: true });
}
