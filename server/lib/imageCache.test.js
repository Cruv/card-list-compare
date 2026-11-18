import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES } from './imageValidation.js';

const reads = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal();
  reads.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, readFileSync: reads.readFileSync };
});
let dir, cache;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'clc-cache-size-'));
  vi.stubEnv('IMAGE_CACHE_DIR', dir);
  vi.resetModules();
  cache = await import('./imageCache.js');
  reads.readFileSync.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('exact printing cache keys', () => {
  it('keeps existing keys and stores marked collectors and their faces separately', () => {
    expect(cache.buildCacheKey('M10', 'DDO-20', 'back')).toBe('m10_DDO-20_back.png');
    const collectors = ['17', '17★', '17†', '17‡'];
    writeFileSync(join(dir, 'm10_17.png'), 'legacy unmarked printing');
    for (const collector of collectors.slice(1)) {
      expect(cache.getCachedImage('m10', collector)).toBeNull();
      cache.cacheImage('m10', collector, null, Buffer.from(`${collector} front`));
      cache.cacheImage('m10', collector, 'back', Buffer.from(`${collector} back`));
    }
    expect(cache.getCachedImage('m10', '17')).toEqual(Buffer.from('legacy unmarked printing'));
    for (const collector of collectors.slice(1)) {
      expect(cache.getCachedImage('m10', collector)).toEqual(Buffer.from(`${collector} front`));
      expect(cache.getCachedImage('m10', collector, 'back')).toEqual(Buffer.from(`${collector} back`));
    }
  });
});

describe('bounded disk cache reads', () => {
  it('rejects oversized exact-printing and name-cache files before reading them into memory', () => {
    for (const filename of [cache.buildCacheKey('m10', '146'), cache.buildNameCacheKey('Lightning Bolt')]) {
      const path = join(dir, filename);
      writeFileSync(path, '');
      truncateSync(path, MAX_IMAGE_BYTES + 1); // sparse fixture, no large allocation
    }
    expect(cache.getCachedImage('m10', '146')).toBeNull();
    expect(cache.getCachedImageByName('Lightning Bolt')).toBeNull();
    expect(reads.readFileSync).not.toHaveBeenCalled();
  });
  it('honors the remaining job budget before reading a smaller cached image', () => {
    writeFileSync(join(dir, cache.buildCacheKey('m10', '146')), 'bytes');
    expect(cache.getCachedImage('m10', '146', null, 4)).toBeNull();
    expect(reads.readFileSync).not.toHaveBeenCalled();
    expect(cache.getCachedImage('m10', '146', null, 5)).toEqual(Buffer.from('bytes'));
    expect(reads.readFileSync).toHaveBeenCalledOnce();
  });
});
