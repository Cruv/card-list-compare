/**
 * Background download queue for Scryfall card image ZIP generation.
 * Single-threaded worker processes one job at a time, serializing Scryfall
 * requests to stay under rate limits regardless of concurrent users.
 */

import crypto from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, unlinkSync, statSync, readdirSync, createWriteStream, renameSync } from 'fs';
import { get, all, run } from '../db.js';
import { parse } from '../../src/lib/parser.js';
import { fetchCardImageUrls, downloadCardImagesWithCache, ImageCompletenessError } from './scryfallImages.js';
import { initImageCache, cleanExpiredImages, enforceSizeLimit } from './imageCache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', 'cardlistcompare.db');
const DATA_DIR = dirname(DB_PATH);
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || join(DATA_DIR, 'downloads');

const MAX_JOBS_PER_USER = 2;
const MAX_QUEUE_DEPTH = 20;
const ZIP_EXPIRY_HOURS = 24;
const IMAGE_CACHE_MAX_DAYS = 30;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let workerActive = false;

/** Initialize the download queue system. Call at server startup after initDb(). */
export function initDownloadQueue() {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  initImageCache();

  // Reset any jobs that were processing when the server stopped (crash recovery)
  try {
    run(`UPDATE image_download_jobs SET status = 'queued', downloaded_images = 0, cached_images = 0, error = NULL WHERE status = 'processing'`);
    // ZIPs from the previous worker may have silently omitted cards/faces.
    run(`UPDATE image_download_jobs SET status = 'failed', error = ?
         WHERE status = 'completed' AND file_path NOT LIKE '%.complete.zip'`,
      ['This ZIP predates completeness checks. Generate it again to verify every card and face.']);
  } catch { /* table might not exist on first run before persist */ }

  // Start the worker if there are queued jobs
  setTimeout(processNextJob, 1000);

  // Run initial cleanup, then schedule hourly
  runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  console.log('[DownloadQueue] Initialized');
}

/**
 * Submit a download job. Returns an existing job if one matches, or creates a new one.
 * @param {number} userId
 * @param {number} trackedDeckId
 * @param {number|null} snapshotId
 * @returns {{ job: object, isExisting: boolean }}
 */
export function submitJob(userId, trackedDeckId, snapshotId) {
  // Freeze 'latest' at submission so queued/reused jobs always identify a version.
  if (!snapshotId) {
    const snapshot = get(`SELECT id FROM deck_snapshots WHERE tracked_deck_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`, [trackedDeckId]);
    if (!snapshot) throw new Error('No snapshot found');
    snapshotId = snapshot.id;
  }

  // Check for reusable completed job (non-expired, file still exists)
  const completedJob = snapshotId
    ? get(`SELECT * FROM image_download_jobs
           WHERE user_id = ? AND tracked_deck_id = ? AND snapshot_id = ?
             AND status = 'completed' AND datetime(expires_at) > datetime('now')
           ORDER BY completed_at DESC LIMIT 1`,
      [userId, trackedDeckId, snapshotId])
    : get(`SELECT * FROM image_download_jobs
           WHERE user_id = ? AND tracked_deck_id = ? AND snapshot_id IS NULL
             AND status = 'completed' AND datetime(expires_at) > datetime('now')
           ORDER BY completed_at DESC LIMIT 1`,
      [userId, trackedDeckId]);

  if (completedJob?.file_path?.endsWith('.complete.zip') && existsSync(completedJob.file_path)) {
    return { job: completedJob, isExisting: true };
  }

  // Check for existing in-flight job (queued or processing)
  const inflightJob = snapshotId
    ? get(`SELECT * FROM image_download_jobs
           WHERE user_id = ? AND tracked_deck_id = ? AND snapshot_id = ?
             AND status IN ('queued', 'processing')
           LIMIT 1`,
      [userId, trackedDeckId, snapshotId])
    : get(`SELECT * FROM image_download_jobs
           WHERE user_id = ? AND tracked_deck_id = ? AND snapshot_id IS NULL
             AND status IN ('queued', 'processing')
           LIMIT 1`,
      [userId, trackedDeckId]);

  if (inflightJob) {
    return { job: inflightJob, isExisting: true };
  }

  // Enforce queue limits
  const userJobCount = get(
    `SELECT COUNT(*) as cnt FROM image_download_jobs WHERE user_id = ? AND status IN ('queued', 'processing')`,
    [userId]
  );
  if (userJobCount && userJobCount.cnt >= MAX_JOBS_PER_USER) {
    throw new Error(`You already have ${MAX_JOBS_PER_USER} pending downloads. Wait for them to finish.`);
  }

  const totalJobCount = get(
    `SELECT COUNT(*) as cnt FROM image_download_jobs WHERE status IN ('queued', 'processing')`
  );
  if (totalJobCount && totalJobCount.cnt >= MAX_QUEUE_DEPTH) {
    throw new Error('Download queue is full. Try again in a few minutes.');
  }

  // Create new job
  const jobId = crypto.randomBytes(8).toString('hex');
  run(`INSERT INTO image_download_jobs (id, user_id, tracked_deck_id, snapshot_id, status)
       VALUES (?, ?, ?, ?, 'queued')`,
    [jobId, userId, trackedDeckId, snapshotId]);

  const job = get('SELECT * FROM image_download_jobs WHERE id = ?', [jobId]);

  // Trigger the worker
  setTimeout(processNextJob, 0);

  return { job, isExisting: false };
}

/** Get a job's current status. */
export function getJobStatus(jobId) {
  // Normalize both historical ISO timestamps and SQLite timestamps in SQL.
  const job = get("SELECT *, datetime(expires_at) <= datetime('now') AS expired FROM image_download_jobs WHERE id = ?", [jobId]);
  if (job?.status === 'completed' && job.file_path && !job.file_path.endsWith('.complete.zip') && !job.expired) {
    return { ...job, status: 'failed', error: 'This ZIP predates completeness checks. Generate it again to verify every card and face.' };
  }
  return job;
}

/** Get the downloads directory path. */
export function getDownloadsDir() {
  return DOWNLOADS_DIR;
}

// ── Worker ──────────────────────────────────────────────────────

async function processNextJob() {
  if (workerActive) return; // Already processing

  const job = get(`SELECT * FROM image_download_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`);
  if (!job) return; // Nothing to do

  workerActive = true;

  // Mark as processing
  run(`UPDATE image_download_jobs SET status = 'processing', total_images = 0, downloaded_images = 0,
       cached_images = 0, error = NULL, file_path = NULL, file_size = NULL WHERE id = ?`, [job.id]);

  try {
    await executeJob(job);
  } catch (err) {
    console.error(`[DownloadQueue] Job ${job.id} failed:`, err.message);
    run(`UPDATE image_download_jobs SET status = 'failed', error = ?, file_path = NULL, file_size = NULL,
         completed_at = datetime('now') WHERE id = ?`,
      [err.message, job.id]);
  }

  // Failed jobs can still cache successfully downloaded faces. Enforce the
  // same disk bound after every attempt, while preserving the job's outcome.
  try {
    const maxCacheMb = getMaxCacheMb();
    if (maxCacheMb > 0) {
      const { evictedCount } = enforceSizeLimit(maxCacheMb);
      if (evictedCount > 0) console.log(`[DownloadQueue] Evicted ${evictedCount} cached images (over ${maxCacheMb}MB cap)`);
    }
  } catch (error) {
    console.error('[DownloadQueue] Cache cleanup failed:', error.message);
  }
  workerActive = false;

  // Check for next job with a small delay
  setTimeout(processNextJob, 2000);
}

async function executeJob(job) {
  // Verify deck ownership
  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?',
    [job.tracked_deck_id, job.user_id]);
  if (!deck) throw new Error('Tracked deck not found');

  // Resolve snapshot
  let snap;
  if (job.snapshot_id) {
    snap = get('SELECT id, deck_text FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?',
      [job.snapshot_id, job.tracked_deck_id]);
  } else {
    snap = get('SELECT id, deck_text FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [job.tracked_deck_id]);
  }
  if (!snap?.deck_text) throw new Error('No snapshot found');

  // Parse deck text
  const parsed = parse(snap.deck_text);
  const cards = [];
  for (const [, entry] of parsed.mainboard) cards.push(entry);
  for (const [, entry] of parsed.sideboard) cards.push(entry);
  for (const name of parsed.commanders) {
    if (!cards.some(c => c.displayName.toLowerCase() === name.toLowerCase())) {
      cards.push({ displayName: name, quantity: 1, setCode: '', collectorNumber: '', isFoil: false });
    }
  }
  if (cards.length === 0) throw new Error('No cards found in the deck');

  // Phase 1 rejects unresolved cards/faces instead of silently shrinking the deck.
  const cardsWithUrls = await fetchCardImageUrls(cards);
  const totalImages = cardsWithUrls.reduce((sum, card) => sum + card.quantity * (card.isDFC ? 2 : 1), 0);
  run(`UPDATE image_download_jobs SET total_images = ? WHERE id = ?`, [totalImages, job.id]);

  // All progress counters count files: two per DFC physical copy.
  let lastReported = -5;
  const result = await downloadCardImagesWithCache(cardsWithUrls, (downloaded, cached, total) => {
    if (downloaded - lastReported >= 5 || downloaded === total) {
      run(`UPDATE image_download_jobs SET downloaded_images = ?, cached_images = ? WHERE id = ?`,
        [downloaded, cached, job.id]);
      lastReported = downloaded;
    }
  });
  const { images, cachedImages, downloadedImages, failures } = result;
  run(`UPDATE image_download_jobs SET downloaded_images = ?, cached_images = ? WHERE id = ?`,
    [downloadedImages, cachedImages, job.id]);
  if (failures.length) throw new ImageCompletenessError(failures);
  if (!totalImages || images.length !== totalImages) {
    throw new Error(`Image download incomplete; expected ${totalImages} files but received ${images.length}. No ZIP was created.`);
  }

  // A .complete.zip is only published after every required face and the archive
  // have succeeded. Partial output is removed on any ZIP/file-system failure.
  const zipPath = join(DOWNLOADS_DIR, `${job.id}.complete.zip`);
  const temporaryPath = `${zipPath}.tmp`;
  const archiver = (await import('archiver')).default;
  const output = createWriteStream(temporaryPath);
  const archive = archiver('zip', { zlib: { level: 1 } });
  const finished = new Promise((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.once('warning', reject);
  });
  try {
    archive.pipe(output);
    for (const img of images) archive.append(img.buffer, { name: img.filename });
    await Promise.all([archive.finalize(), finished]);
    renameSync(temporaryPath, zipPath);

    const fileSize = statSync(zipPath).size;
    const expiresAt = new Date(Date.now() + ZIP_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    run(`UPDATE image_download_jobs
         SET status = 'completed', file_path = ?, file_size = ?,
             downloaded_images = ?, cached_images = ?,
             completed_at = datetime('now'), expires_at = ?
         WHERE id = ?`,
      [zipPath, fileSize, images.length, cachedImages, expiresAt, job.id]);
    console.log(`[DownloadQueue] Job ${job.id} completed: ${images.length} verified images, ${cachedImages} from cache, ZIP ${(fileSize / 1024 / 1024).toFixed(1)}MB`);
  } catch (error) {
    archive.abort();
    output.destroy();
    for (const path of [temporaryPath, zipPath]) {
      try { unlinkSync(path); } catch { /* absent or already removed */ }
    }
    throw error;
  }


}

function getMaxCacheMb() {
  const setting = get("SELECT value FROM server_settings WHERE key = 'max_image_cache_mb'");
  return parseInt(setting?.value || '500', 10);
}

// ── Cleanup ──────────────────────────────────────────────────────

function runCleanup() {
  try {
    let expiredZips = 0;
    let cleanedRecords = 0;
    let orphanedFiles = 0;

    // Delete expired ZIP files
    const expiredJobs = all(
      `SELECT id, file_path FROM image_download_jobs WHERE datetime(expires_at) <= datetime('now') AND file_path IS NOT NULL`
    );
    for (const job of expiredJobs) {
      if (job.file_path && existsSync(job.file_path)) {
        try { unlinkSync(job.file_path); expiredZips++; } catch { /* ignore */ }
      }
    }

    // Clean null out expired file_paths
    if (expiredJobs.length > 0) {
      run(`UPDATE image_download_jobs SET file_path = NULL, file_size = NULL WHERE datetime(expires_at) <= datetime('now') AND file_path IS NOT NULL`);
    }

    // Delete old job records (48 hours after creation)
    const deleteResult = run(`DELETE FROM image_download_jobs WHERE created_at < datetime('now', '-48 hours')`);
    cleanedRecords = deleteResult.changes || 0;

    // Delete orphaned ZIP files (no matching job in DB)
    try {
      const zipFiles = readdirSync(DOWNLOADS_DIR).filter(f => f.endsWith('.zip') || f.endsWith('.zip.tmp'));
      const jobIds = new Set(
        all(`SELECT id FROM image_download_jobs WHERE file_path IS NOT NULL OR status IN ('queued', 'processing')`).map(j => j.id)
      );
      for (const f of zipFiles) {
        const jobId = f.replace(/(?:\.complete)?\.zip(?:\.tmp)?$/, '');
        if (!jobIds.has(jobId)) {
          try { unlinkSync(join(DOWNLOADS_DIR, f)); orphanedFiles++; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore if dir doesn't exist */ }

    // Clean expired cached images (30 days by mtime)
    const { deletedCount: expiredImages } = cleanExpiredImages(IMAGE_CACHE_MAX_DAYS);

    // Enforce image cache size cap
    const maxCacheMb = getMaxCacheMb();
    const { evictedCount } = maxCacheMb > 0 ? enforceSizeLimit(maxCacheMb) : { evictedCount: 0 };

    const totalCleaned = expiredZips + cleanedRecords + orphanedFiles + expiredImages + evictedCount;
    if (totalCleaned > 0) {
      console.log(`[DownloadQueue] Cleanup: ${expiredZips} ZIPs, ${cleanedRecords} records, ${orphanedFiles} orphans, ${expiredImages} expired images, ${evictedCount} evicted`);
    }
  } catch (err) {
    console.error('[DownloadQueue] Cleanup error:', err.message);
  }
}
