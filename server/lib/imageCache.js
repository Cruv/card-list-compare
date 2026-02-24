/**
 * Persistent disk cache for Scryfall card images.
 * Images cached by set+collector key, shared across all users and decks.
 * LRU eviction enforced by configurable size cap (admin setting: max_image_cache_mb).
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, utimesSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', 'cardlistcompare.db');
const DATA_DIR = dirname(DB_PATH);
const CACHE_DIR = process.env.IMAGE_CACHE_DIR || join(DATA_DIR, 'image-cache');

/** Initialize the cache directory. Call at server startup. */
export function initImageCache() {
  mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

/** Get the cache directory path. */
export function getCacheDir() {
  return CACHE_DIR;
}

/**
 * Build a filesystem-safe cache key for a card image.
 * @param {string} set — set code (e.g. 'm10')
 * @param {string} collector — collector number (e.g. '227', '136p')
 * @param {string} [face] — 'back' for DFC back face, omit for front
 * @returns {string} filename like 'm10_227.png' or 'ltr_551_back.png'
 */
export function buildCacheKey(set, collector, face) {
  if (set && collector) {
    const s = set.toLowerCase().replace(/[^a-z0-9]/g, '');
    const c = String(collector).replace(/[^a-zA-Z0-9_-]/g, '');
    const suffix = face ? `_${face}` : '';
    return `${s}_${c}${suffix}.png`;
  }
  // Fallback: no set/collector — should not happen often since Scryfall resolves it
  return null;
}

/**
 * Build a name-based cache key for cards without set/collector metadata.
 * @param {string} name — card display name
 * @param {string} [face] — 'back' for DFC back face
 * @returns {string} filename like '_name_lightning_bolt.png'
 */
export function buildNameCacheKey(name, face) {
  const safe = name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const suffix = face ? `_${face}` : '';
  return `_name_${safe}${suffix}.png`;
}

/**
 * Get a cached image from disk.
 * @returns {Buffer|null}
 */
export function getCachedImage(set, collector, face) {
  const key = buildCacheKey(set, collector, face);
  if (!key) return null;

  const filePath = join(CACHE_DIR, key);
  if (!existsSync(filePath)) return null;

  try {
    // Touch mtime for LRU tracking
    const now = new Date();
    utimesSync(filePath, now, now);
    return readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Get a cached image by name (fallback for cards without set/collector).
 * @returns {Buffer|null}
 */
export function getCachedImageByName(name, face) {
  const key = buildNameCacheKey(name, face);
  const filePath = join(CACHE_DIR, key);
  if (!existsSync(filePath)) return null;

  try {
    const now = new Date();
    utimesSync(filePath, now, now);
    return readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Write an image to the disk cache.
 * @returns {string} the cache key used
 */
export function cacheImage(set, collector, face, buffer) {
  const key = buildCacheKey(set, collector, face);
  if (!key) return null;

  try {
    writeFileSync(join(CACHE_DIR, key), buffer);
    return key;
  } catch (err) {
    console.error('Image cache write error:', err.message);
    return null;
  }
}

/**
 * Write an image to cache using name-based key (fallback).
 * @returns {string} the cache key used
 */
export function cacheImageByName(name, face, buffer) {
  const key = buildNameCacheKey(name, face);
  try {
    writeFileSync(join(CACHE_DIR, key), buffer);
    return key;
  } catch (err) {
    console.error('Image cache write error:', err.message);
    return null;
  }
}

/**
 * Enforce the size cap by evicting least-recently-used files.
 * @param {number} maxMb — max cache size in MB (0 = unlimited)
 * @returns {{ evictedCount: number, freedBytes: number }}
 */
export function enforceSizeLimit(maxMb) {
  if (!maxMb || maxMb <= 0) return { evictedCount: 0, freedBytes: 0 };

  const maxBytes = maxMb * 1024 * 1024;
  let files;
  try {
    files = readdirSync(CACHE_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => {
        const p = join(CACHE_DIR, f);
        const stat = statSync(p);
        return { name: f, path: p, size: stat.size, mtimeMs: stat.mtimeMs };
      });
  } catch {
    return { evictedCount: 0, freedBytes: 0 };
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize <= maxBytes) return { evictedCount: 0, freedBytes: 0 };

  // Sort by mtime ascending (oldest first = least recently used)
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let evictedCount = 0;
  let freedBytes = 0;
  let currentSize = totalSize;

  for (const file of files) {
    if (currentSize <= maxBytes) break;
    try {
      unlinkSync(file.path);
      currentSize -= file.size;
      freedBytes += file.size;
      evictedCount++;
    } catch { /* ignore individual file errors */ }
  }

  return { evictedCount, freedBytes };
}

/**
 * Delete cached images older than maxAgeDays (by mtime).
 * @param {number} [maxAgeDays=30]
 * @returns {{ deletedCount: number, freedBytes: number }}
 */
export function cleanExpiredImages(maxAgeDays = 30) {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deletedCount = 0;
  let freedBytes = 0;

  try {
    const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.png'));
    for (const f of files) {
      const p = join(CACHE_DIR, f);
      try {
        const stat = statSync(p);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(p);
          deletedCount++;
          freedBytes += stat.size;
        }
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* ignore if dir doesn't exist */ }

  return { deletedCount, freedBytes };
}

/**
 * Get cache statistics.
 * @returns {{ totalFiles: number, totalSizeBytes: number }}
 */
export function getCacheStats() {
  let totalFiles = 0;
  let totalSizeBytes = 0;

  try {
    const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.png'));
    for (const f of files) {
      try {
        const stat = statSync(join(CACHE_DIR, f));
        totalFiles++;
        totalSizeBytes += stat.size;
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist */ }

  return { totalFiles, totalSizeBytes };
}
