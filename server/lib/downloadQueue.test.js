import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = vi.hoisted(() => ({ get: vi.fn(), all: vi.fn(), run: vi.fn() }));
const downloads = vi.hoisted(() => ({ fetchCardImageUrls: vi.fn(), downloadCardImagesWithCache: vi.fn() }));
vi.mock('../db.js', () => db);
vi.mock('./scryfallImages.js', async importOriginal => ({ ...(await importOriginal()), ...downloads }));
const cachePolicy = vi.hoisted(() => ({ initImageCache: vi.fn(), cleanExpiredImages: vi.fn(() => ({ deletedCount: 0 })), enforceSizeLimit: vi.fn(() => ({ evictedCount: 0 })) }));
vi.mock('./imageCache.js', () => cachePolicy);

let dir, queue, job, workers, maxCacheMb;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'clc-queue-complete-'));
  vi.stubEnv('DOWNLOADS_DIR', dir);
  vi.stubEnv('DB_PATH', join(dir, 'never-opened.db'));
  job = undefined;
  workers = [];
  maxCacheMb = '0';
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
    if (callback.name === 'processNextJob') { workers.push(callback); return 1; }
    return realSetTimeout(callback, ms, ...args);
  });
  db.get.mockImplementation(sql => {
    if (sql.includes('FROM deck_snapshots')) return { id: 17, deck_text: '2 Malakir Rebirth (ZNR) 111' };
    if (sql.includes('FROM tracked_decks')) return { id: 2, user_id: 1 };
    if (sql.includes('COUNT(*)')) return { cnt: 0 };
    if (sql.includes('server_settings')) return { value: maxCacheMb };
    if (sql.includes("WHERE status = 'queued'")) return job?.status === 'queued' ? job : undefined;
    if (sql.includes("AND status = 'completed'")) return job?.status === 'completed' ? job : undefined;
    if (sql.includes("AND status IN ('queued', 'processing')")) return undefined;
    if (sql.includes('WHERE id = ?')) return job;
    return undefined;
  });
  db.run.mockImplementation((sql, args = []) => {
    if (sql.includes('INSERT INTO image_download_jobs')) {
      job = { id: args[0], user_id: args[1], tracked_deck_id: args[2], snapshot_id: args[3], status: 'queued' };
    } else if (sql.includes("SET status = 'processing'")) job.status = 'processing';
    else if (sql.includes("SET status = 'failed'")) Object.assign(job, { status: 'failed', error: args[0], file_path: null });
    else if (sql.includes("SET status = 'completed'")) {
      Object.assign(job, { status: 'completed', file_path: args[0], file_size: args[1], downloaded_images: args[2], cached_images: args[3] });
    } else if (sql.includes('SET total_images = ?')) job.total_images = args[0];
    else if (sql.includes('SET downloaded_images = ?')) Object.assign(job, { downloaded_images: args[0], cached_images: args[1] });
    return { changes: 1 };
  });
  downloads.fetchCardImageUrls.mockResolvedValue([{ displayName: 'Malakir Rebirth', quantity: 2, isDFC: true }]);
  queue = await import('./downloadQueue.js');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function execute() {
  queue.submitJob(1, 2, null);
  await workers.shift()();
}

describe('image ZIP publication', () => {
  it('pins latest to an exact snapshot and fails without creating a ZIP when metadata is incomplete', async () => {
    const { ImageCompletenessError } = await import('./scryfallImages.js');
    downloads.fetchCardImageUrls.mockRejectedValue(new ImageCompletenessError([
      { displayName: 'Malakir Rebirth', setCode: 'znr', collectorNumber: '111', quantity: 2, face: 'back', reason: 'No image URL available' },
    ]));
    await execute();
    expect(job.snapshot_id).toBe(17);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('2x Malakir Rebirth (znr #111) — back');
    expect(downloads.downloadCardImagesWithCache).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fails a job with any face download failure and still enforces the disk-cache cap', async () => {
    maxCacheMb = '500';
    downloads.downloadCardImagesWithCache.mockResolvedValue({
      images: [{ filename: 'front.png', buffer: Buffer.from('front') }], downloadedImages: 2, cachedImages: 0,
      failures: [{ displayName: 'Malakir Rebirth', quantity: 2, face: 'back', reason: 'HTTP 404' }],
    });
    await execute();
    expect(job).toMatchObject({ status: 'failed', total_images: 4, downloaded_images: 2, file_path: null });
    expect(cachePolicy.enforceSizeLimit).toHaveBeenCalledWith(500);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('independently rejects an incorrect file count even if the downloader reports no failures', async () => {
    downloads.downloadCardImagesWithCache.mockResolvedValue({ images: [], downloadedImages: 0, cachedImages: 0, failures: [] });
    await execute();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('expected 4 files but received 0');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('marks filesystem failures failed without publishing a download path', async () => {
    downloads.downloadCardImagesWithCache.mockResolvedValue({
      images: Array.from({ length: 4 }, (_, n) => ({ filename: `${n}.png`, buffer: Buffer.from('image') })),
      downloadedImages: 4, cachedImages: 0, failures: [],
    });
    queue.submitJob(1, 2, 17);
    // Simulate an unavailable bind mount without permission-dependent chmod behavior.
    rmSync(dir, { recursive: true });
    writeFileSync(dir, 'not a directory');
    await workers.shift()();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('ENOTDIR');
    expect(job.file_path).toBeNull();
  });

  it('publishes an atomic ZIP with every physical-copy face and consistent progress', async () => {
    const images = ['001_1_front.png', '001_2_back.png', '002_1_front.png', '002_2_back.png']
      .map(filename => ({ filename, buffer: Buffer.from(filename) }));
    downloads.downloadCardImagesWithCache.mockImplementation(async (_cards, progress) => {
      progress(4, 2, 4);
      return { images, downloadedImages: 4, cachedImages: 2, failures: [] };
    });
    await execute();
    expect(job).toMatchObject({ status: 'completed', total_images: 4, downloaded_images: 4, cached_images: 2 });
    expect(job.file_path).toBe(join(dir, `${job.id}.complete.zip`));
    expect(readdirSync(dir)).toEqual([`${job.id}.complete.zip`]);
    const zipBytes = readFileSync(job.file_path);
    // Every expected name appears in a central-directory record and local header.
    for (const { filename } of images) expect(zipBytes.includes(Buffer.from(filename))).toBe(true);
    expect(zipBytes.readUInt32LE(zipBytes.length - 22)).toBe(0x06054b50);
    expect(zipBytes.readUInt16LE(zipBytes.length - 12)).toBe(4);
  });
});
