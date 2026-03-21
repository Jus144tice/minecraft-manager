// Mod metadata cache: avoids repeated Modrinth API calls for installed mods.
// Uses PostgreSQL when available, falls back to in-memory Map.
// Icon images are cached to data/icon-cache/ on disk.

import { mkdir, readdir, unlink, writeFile } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { isConnected, getModCacheBatch, upsertModCacheBatch, deleteModCache, clearModCache } from './db.js';

// TTLs
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory fallback
const memoryCache = new Map(); // sha1 -> { found, metadata, cachedAt }

// Icon cache directory
const ICON_DIR = path.join(process.cwd(), 'data', 'icon-cache');

/** Ensure the icon cache directory exists. Call once at startup. */
export async function initIconCache() {
  await mkdir(ICON_DIR, { recursive: true });
}

/**
 * Batch-lookup cached mod metadata.
 * Returns Map<sha1, { found, metadata }> for hashes with valid (non-expired) cache entries.
 */
export async function getCachedBatch(hashes) {
  const result = new Map();
  if (hashes.length === 0) return result;

  if (isConnected()) {
    const rows = await getModCacheBatch(hashes);
    const now = Date.now();
    for (const row of rows) {
      const ttl = row.found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
      const cachedAt = new Date(row.cached_at).getTime();
      if (now - cachedAt <= ttl) {
        result.set(row.sha1, { found: row.found, metadata: row.metadata });
      }
    }
  } else {
    const now = Date.now();
    for (const h of hashes) {
      const entry = memoryCache.get(h);
      if (!entry) continue;
      const ttl = entry.found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
      if (now - entry.cachedAt > ttl) {
        memoryCache.delete(h);
        continue;
      }
      result.set(h, { found: entry.found, metadata: entry.metadata });
    }
  }
  return result;
}

/**
 * Store multiple cache entries.
 * @param {Array<{ sha1: string, found: boolean, metadata: object|null }>} entries
 */
export async function setCachedBatch(entries) {
  if (entries.length === 0) return;

  if (isConnected()) {
    await upsertModCacheBatch(entries);
  } else {
    const now = Date.now();
    for (const { sha1, found, metadata } of entries) {
      memoryCache.set(sha1, { found, metadata, cachedAt: now });
    }
  }
}

/** Remove a single cache entry. */
export async function invalidateHash(sha1) {
  if (isConnected()) {
    await deleteModCache(sha1);
  } else {
    memoryCache.delete(sha1);
  }
  // Remove cached icon
  removeIcon(sha1).catch(() => {});
}

/** Clear the entire cache. */
export async function invalidateAll() {
  if (isConnected()) {
    await clearModCache();
  } else {
    memoryCache.clear();
  }
  // Clear icon cache directory
  try {
    const files = await readdir(ICON_DIR);
    await Promise.all(files.map((f) => unlink(path.join(ICON_DIR, f))));
  } catch {
    /* directory may not exist */
  }
}

/**
 * Download and cache an icon image to disk.
 * Fire-and-forget — failures are silently ignored.
 */
export async function cacheIcon(sha1, iconUrl) {
  if (!iconUrl) return;
  try {
    const ext = path.extname(new URL(iconUrl).pathname) || '.png';
    const filePath = path.join(ICON_DIR, `${sha1}${ext}`);
    if (existsSync(filePath)) return; // already cached

    const res = await fetch(iconUrl);
    if (!res.ok) return;
    const buffer = Buffer.from(await res.arrayBuffer());
    await mkdir(ICON_DIR, { recursive: true });
    await writeFile(filePath, buffer);
  } catch {
    /* best-effort */
  }
}

/** Remove a cached icon file. */
async function removeIcon(sha1) {
  try {
    const files = await readdir(ICON_DIR);
    const match = files.find((f) => f.startsWith(sha1));
    if (match) await unlink(path.join(ICON_DIR, match));
  } catch {
    /* ignore */
  }
}

/**
 * Resolve the local icon file path for a SHA1 hash.
 * Returns the full path if cached, or null.
 */
export function getIconPath(sha1) {
  if (!/^[a-f0-9]{40}$/i.test(sha1)) return null;
  try {
    if (!existsSync(ICON_DIR)) return null;
    const files = readdirSync(ICON_DIR);
    const match = files.find((f) => f.startsWith(sha1));
    return match ? path.join(ICON_DIR, match) : null;
  } catch {
    return null;
  }
}
