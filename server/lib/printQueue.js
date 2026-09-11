/** Durable preparation and household station state machine. No shell/printer commands. */
import crypto from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, openSync, readSync, closeSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { get, all, run, runTransaction } from '../db.js';
import { buildPrintPlan, publicPrintPlan, printError, sha256 } from './printQueuePlan.js';
import { preparePrintImages } from './printQueueImages.js';
import { generatePrintPdfs, getPrintGeneratorStatus, prunePrintGenerator } from './printGenerator.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = dirname(process.env.DB_PATH || join(here, '..', 'data', 'cardlistcompare.db'));
export const PRINT_JOBS_DIR = process.env.PRINT_JOBS_DIR || join(dataDir, 'print-jobs');
export const PRINT_RETENTION_DAYS = 7;
export const MAX_PRINT_JOB_BYTES = 2 * 1024 * 1024 * 1024;
// Includes the retained job, duplicate PDF merge parts, and one decoded chunk's
// source copies. Preparation runs serially, so only one allowance is reserved.
export const PRINT_WORKING_RESERVE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const MANIFEST_RESERVE_BYTES = 1024 * 1024;
const STORAGE_MAX_BYTES = Math.max(1, Number(process.env.PRINT_STORAGE_MAX_MB) || 10240) * 1024 * 1024;
const LEASE_MS = 120000;
const STATION_ID = 'household';
const ACTIVE_STATES = ['claimed', 'submitting', 'submitted', 'awaiting_refeed', 'uncertain'];
const PHYSICAL_STATES = ['submitting', 'submitted', 'awaiting_refeed', 'uncertain'];
const NEVER_EXPIRE = ['preparing', 'queued', ...ACTIVE_STATES];
let workerActive = false;
let timer;
const controllers = new Map();
const now = () => new Date().toISOString();
const retentionExpiry = () => new Date(Date.now() + PRINT_RETENTION_DAYS * 86400000).toISOString();
const leaseExpiry = () => new Date(Date.now() + LEASE_MS).toISOString();
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value || 'null');
const jobDir = id => join(PRINT_JOBS_DIR, id);

export function printCapabilities(userId) {
  const token = process.env.PRINT_STATION_TOKEN || '';
  const stationConfigured = token.length >= 32;
  const user = get('SELECT id, is_admin, suspended FROM users WHERE id = ?', [userId]);
  const allowed = (process.env.PRINT_ALLOWED_USER_IDS || '').split(',').map(value => Number(value.trim())).filter(id => Number.isSafeInteger(id) && id > 0);
  return {
    stationConfigured, canQueue: !!(stationConfigured && user && !user.suspended && (user.is_admin || allowed.includes(userId))),
    recipeId: 'household-letter-v6', retentionDays: PRINT_RETENTION_DAYS, maxCopies: 250,
  };
}
export function requireStationToken(token) {
  const expected = process.env.PRINT_STATION_TOKEN || '';
  if (expected.length < 32) throw printError('Household print station is not configured', 503);
  const actualHash = Buffer.from(sha256(String(token || ''))), expectedHash = Buffer.from(sha256(expected));
  if (!crypto.timingSafeEqual(actualHash, expectedHash)) throw printError('Invalid station credential', 401);
}
function assertCanQueue(userId) {
  if (!printCapabilities(userId).canQueue) throw printError('Printing is restricted to authorized household users and requires a configured station', 403);
}
function ownerJob(userId, deckId, id) {
  const row = get('SELECT * FROM print_jobs WHERE id = ? AND user_id = ? AND tracked_deck_id = ?', [id, userId, deckId]);
  if (!row) throw printError('Print job not found', 404);
  return row;
}
let claimSecret;
function claimToken(row) {
  // Job identity survives station-auth credential rotation. This independent
  // signing key lives with the persisted jobs and is included in data backups.
  if (!claimSecret) {
    const path = join(dataDir, '.print-claim-secret');
    mkdirSync(dataDir, { recursive: true });
    try { writeFileSync(path, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stored = readFileSync(path, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(stored)) throw printError('The persisted print claim signing key is invalid', 503);
    claimSecret = stored;
  }
  return crypto.createHmac('sha256', claimSecret).update(`${row.id}:${row.claim_nonce}`).digest('hex');
}

function safeId(value, field) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw printError(`${field} must be an opaque 8–128 character identifier`);
  return value;
}
// Bound checksum memory even for a complete 600-PPI deck PDF.
function hashPdf(path) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, 'r');
  let isPdf = false, first = true;
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      if (first) { isPdf = buffer.subarray(0, Math.min(5, bytes)).equals(Buffer.from('%PDF-')); first = false; }
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { closeSync(fd); }
  return { hash: hash.digest('hex'), isPdf };
}

function directoryStorage(path) {
  if (!existsSync(path)) return 0;
  let bytes = 0;
  for (const item of readdirSync(path, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw printError('Unexpected link in print storage', 503);
    bytes += item.isDirectory() ? directoryStorage(join(path, item.name)) : statSync(join(path, item.name)).size;
  }
  return bytes;
}
function totalStorage(path) {
  return path ? directoryStorage(path) : directoryStorage(PRINT_JOBS_DIR) + directoryStorage(join(dataDir,'manasync-artwork'));
}
export function assertPrintStorageCapacity(additionalBytes = 0) {
  if (totalStorage() + additionalBytes > STORAGE_MAX_BYTES) throw printError('Print storage is full, including retained ManaSync artwork. Free space before retaining more print plans.',507);
}
function artifactRecord(row, artifact, station) {
  return {
    id: artifact.id, kind: artifact.kind, sha256: artifact.sha256, size: artifact.size,
    pageCount: artifact.pageCount, sheetCount: artifact.sheetCount, cardCount: artifact.cardCount,
    ...(artifact.label ? { label: artifact.label } : {}),
    ...(artifact.packetIndex ? { packetIndex: artifact.packetIndex, packetCount: artifact.packetCount } : {}),
    frontPages: artifact.kind === 'dfc' ? Array.from({ length: artifact.sheetCount }, (_, n) => n * 2 + 1) : Array.from({ length: artifact.pageCount }, (_, n) => n + 1),
    backPages: artifact.kind === 'dfc' ? Array.from({ length: artifact.sheetCount }, (_, n) => n * 2 + 2) : [],
    downloadUrl: station
      ? `/api/print-station/jobs/${row.id}/artifacts/${artifact.id}`
      : `/api/decks/${row.tracked_deck_id}/print-jobs/${row.id}/artifacts/${artifact.id}`,
  };
}
export function formatPrintJob(row, station = false) {
  const plan = parse(row.plan_json), manifest = parse(row.manifest_json);
  const value = {
    id: row.id, state: row.state, mode: plan.mode, deckId: row.tracked_deck_id, deckName: plan.deckName,
    requesterId: row.user_id, totalCopies: plan.totalCopies, artSource: plan.artSource,
    source: publicPrintPlan(plan).source, target: publicPrintPlan(plan).target,
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
    queueOnReady: !!row.queue_requested, error: row.error, proxyStagingError: row.proxy_staging_error || null, progress: parse(row.progress_json),
    recipeId: manifest?.recipe?.id || 'household-letter-v6', manifestSha256: row.manifest_sha256,
    artifacts: row.state === 'expired' ? [] : (manifest?.artifacts || []).map(artifact => artifactRecord(row, artifact, station)),
    steps: parse(row.steps_json) || [],
  };
  if (station) Object.assign(value, { claimToken: claimToken(row), leaseExpiresAt: row.lease_expires_at });
  return value;
}
export const getOwnedPrintJob = (userId, deckId, id) => formatPrintJob(ownerJob(userId, deckId, id));
export function listPrintJobs(userId, deckId) {
  return all('SELECT * FROM print_jobs WHERE user_id = ? AND tracked_deck_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId, deckId]).map(row => formatPrintJob(row));
}

export async function createPrintJob(userId, deckId, request) {
  const requestKey = safeId(request.idempotencyKey, 'idempotencyKey');
  if (typeof request.expectedPlanHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedPlanHash)) throw printError('Preview the print plan before creating a job');
  if (request.queueOnReady !== undefined && typeof request.queueOnReady !== 'boolean') throw printError('queueOnReady must be true or false');
  const requestHash = sha256(json({ deckId, expectedPlanHash: request.expectedPlanHash, queueOnReady: !!request.queueOnReady }));
  const replay = () => {
    const existing = get('SELECT * FROM print_jobs WHERE user_id = ? AND request_key = ?', [userId, requestKey]);
    if (!existing) return null;
    if (existing.request_hash !== requestHash) throw printError('This request key already belongs to a different print request', 409);
    return { job: formatPrintJob(existing), isExisting: true };
  };
  const existing = replay();
  if (existing) return existing;
  const plan = await buildPrintPlan(userId, deckId, request);
  // Two concurrent requests can resolve metadata together. Recheck the durable
  // receipt after that await before inserting or consuming pending-job capacity.
  const concurrent = replay();
  if (concurrent) return concurrent;
  if (plan.planHash !== request.expectedPlanHash) throw printError('Snapshots or artwork changed after preview. Review a fresh plan.', 409);
  if (!plan.totalCopies) throw printError('This comparison has no copies to print');
  if (!plan.readyToGenerate) throw printError(`Review the missing or unsupported artwork before generating: ${plan.resolvedCards.filter(card => card.errors.length).map(card => `${card.displayName}: ${card.errors.join('; ')}`).join(', ')}`);
  if (request.queueOnReady) assertCanQueue(userId);
  const pending = get("SELECT COUNT(*) AS count FROM print_jobs WHERE user_id = ? AND state IN ('preparing', 'queued')", [userId]);
  if (pending.count >= 2) throw printError('You already have two pending print jobs', 429);
  if (get("SELECT COUNT(*) AS count FROM print_jobs WHERE state = 'preparing'").count >= 10) throw printError('The PDF preparation queue is full', 429);
  cleanupPrintArtifacts();
  if (totalStorage() + PRINT_WORKING_RESERVE_BYTES > STORAGE_MAX_BYTES) throw printError('Print storage lacks the 5 GiB working allowance. Remove or expire completed artifacts before preparing more PDFs.', 507);
  const id = crypto.randomUUID(), timestamp = now();
  run(`INSERT INTO print_jobs (id, user_id, tracked_deck_id, request_key, request_hash, plan_json, queue_requested, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, userId, deckId, requestKey, requestHash, json(plan), request.queueOnReady ? 1 : 0, timestamp, timestamp]);
  triggerWorker();
  return { job: getOwnedPrintJob(userId, deckId, id), isExisting: false };
}
function triggerWorker(delayMs = 10) {
  if (!timer) { timer = setTimeout(() => { timer = null; void processNextPrintJob(); }, delayMs); timer.unref?.(); }
}

export function initPrintQueue() {
  mkdirSync(PRINT_JOBS_DIR, { recursive: true });
  // A preparation can be regenerated from frozen inputs; a physical intent cannot.
  for (const row of all("SELECT * FROM print_jobs WHERE state = 'preparing'")) rmSync(jobDir(row.id), { recursive: true, force: true });
  for (const row of all("SELECT * FROM print_jobs WHERE state = 'submitting'")) {
    const steps = parse(row.steps_json).map(step => step.state === 'submitting' ? { ...step, state: 'uncertain', detail: 'Server restarted after submission intent' } : step);
    run("UPDATE print_jobs SET state = 'uncertain', steps_json = ?, error = ?, updated_at = ? WHERE id = ?", [json(steps), 'Submission outcome requires station reconciliation after restart', now(), row.id]);
  }
  cleanupPrintArtifacts();
  triggerWorker();
  const cleanupTimer = setInterval(cleanupPrintArtifacts, 60 * 60 * 1000);
  cleanupTimer.unref?.();
  return () => { clearInterval(cleanupTimer); if (timer) clearTimeout(timer); timer = null; };
}

export async function processNextPrintJob() {
  if (workerActive) return;
  const row = get("SELECT * FROM print_jobs WHERE state = 'preparing' ORDER BY created_at, id LIMIT 1");
  if (!row) return;
  workerActive = true;
  const controller = new AbortController(); controllers.set(row.id, controller);
  const assertActive = () => {
    if (controller.signal.aborted || get('SELECT state FROM print_jobs WHERE id = ?', [row.id])?.state !== 'preparing') throw printError('Print preparation was canceled', 409);
  };
  let lastProgress = 0;
  let resumeDelay = 10;
  const progress = value => {
    assertActive();
    if (Date.now() - lastProgress >= 500 || value.phase === 'generating') {
      run('UPDATE print_jobs SET progress_json = ?, updated_at = ? WHERE id = ?', [json(value), now(), row.id]);
      lastProgress = Date.now();
    }
  };
  try {
    const status = getPrintGeneratorStatus();
    if (!status.available && status.updating) { resumeDelay = 5000; return; }
    if (!status.available) throw printError(status.fallbackReason || 'PDF generator is unavailable. Retry its update before preparing PDFs.', 503);
    if (totalStorage() + PRINT_WORKING_RESERVE_BYTES > STORAGE_MAX_BYTES) throw printError('Print storage is full; PDF preparation requires a 5 GiB working allowance', 507);
    const plan = parse(row.plan_json);
    mkdirSync(jobDir(row.id), { recursive: true });
    const copies = await preparePrintImages(plan, jobDir(row.id), progress);
    assertActive();
    const maxOutputBytes = MAX_PRINT_JOB_BYTES - totalStorage(jobDir(row.id)) - MANIFEST_RESERVE_BYTES;
    if (maxOutputBytes <= 0) throw printError('Source images exceed the print-job storage limit', 507);
    const generated = await generatePrintPdfs({
      cards: copies.map(copy => ({ id: copy.id, frontPath: copy.front.path, ...(copy.back ? { backPath: copy.back.path } : {}) })),
      outputDir: join(jobDir(row.id), 'output'), batchLabel: `CLC ${row.id.slice(0, 8)}`,
      maxOutputBytes, signal: controller.signal, onProgress: progress,
    });
    assertActive();
    if (totalStorage(jobDir(row.id)) > MAX_PRINT_JOB_BYTES) throw printError('Generated job exceeds the 2 GiB storage limit', 507);
    let outputBytes = 0;
    if (!Array.isArray(generated.artifacts) || generated.artifacts.length > 37) throw printError('Generator returned too many artifacts', 500);
    const artifactIds = new Set();
    const packets = generated.artifacts.filter(artifact => /^double-faced-\d{3}$/.test(artifact.id));
    const artifacts = generated.artifacts.map(artifact => {
      const path = realpathSync(artifact.path);
      const root = realpathSync(jobDir(row.id)) + sep;
      if (!path.startsWith(root) || !/^(fronts|double-faced(?:-\d{3})?)$/.test(artifact.id)
        || artifactIds.has(artifact.id) || !['ordinary', 'dfc'].includes(artifact.kind)) throw printError('Generator returned an invalid artifact', 500);
      artifactIds.add(artifact.id);
      if (packets.includes(artifact)) {
        const index = packets.indexOf(artifact) + 1;
        if (artifact.id !== `double-faced-${String(index).padStart(3, '0')}` || artifact.kind !== 'dfc'
          || artifact.sheetCount !== 1 || artifact.pageCount !== 2 || artifact.packetIndex !== index
          || artifact.packetCount !== packets.length || !Number.isSafeInteger(artifact.cardCount)
          || artifact.cardCount < 1 || artifact.cardCount > 7
          || artifact.label !== `CLC ${row.id.slice(0, 8)} DFC ${index}/${packets.length}`) {
          throw printError('Generator returned an invalid double-sided packet', 500);
        }
      } else if (packets.length && artifact.kind === 'dfc') throw printError('Generator mixed packet and legacy double-sided groups', 500);
      const size = statSync(path).size; outputBytes += size;
      if (size > MAX_OUTPUT_BYTES || outputBytes > maxOutputBytes) throw printError('Generated PDFs exceed the artifact or job storage limit', 507);
      const { hash, isPdf } = hashPdf(path);
      if (!isPdf || hash !== artifact.sha256 || !Number.isSafeInteger(artifact.pageCount) || artifact.pageCount < 1) throw printError('Generated PDF verification failed', 500);
      if (artifact.kind === 'dfc' && artifact.pageCount !== artifact.sheetCount * 2) throw printError('Double-faced PDF page pairing is incomplete', 500);
      const { path: _path, ...metadata } = artifact;
      return { ...metadata, size, sha256: hash, fileName: relative(realpathSync(jobDir(row.id)), path) };
    });
    if (!artifacts.length || artifacts.reduce((count, artifact) => count + artifact.cardCount, 0) !== plan.totalCopies) throw printError('Generated PDF copy count does not match the plan', 500);
    const withoutPath = image => { const { path: _path, ...record } = image; return record; };
    const manifest = {
      version: 1, jobId: row.id, requesterId: row.user_id, createdAt: row.created_at, plan,
      copies: copies.map(copy => ({ ...copy, front: withoutPath(copy.front), ...(copy.back ? { back: withoutPath(copy.back) } : {}) })),
      generatorRevision: generated.revision, generatorRuntimeVersion: generated.runtimeVersion, recipe: generated.recipe, artifacts, slots: generated.slots,
      images: generated.images || [], generatedAt: now(),
    };
    const bytes = json(manifest), hash = sha256(bytes);
    if (Buffer.byteLength(bytes) > MANIFEST_RESERVE_BYTES) throw printError('Print manifest exceeds the storage limit', 507);
    writeFileSync(join(jobDir(row.id), 'manifest.json.tmp'), bytes, { flag: 'wx' });
    renameSync(join(jobDir(row.id), 'manifest.json.tmp'), join(jobDir(row.id), 'manifest.json'));
    const steps = artifacts.flatMap(artifact => artifact.kind === 'dfc'
      ? [{ artifactId: artifact.id, phase: 'fronts', state: 'pending' }, { artifactId: artifact.id, phase: 'backs', state: 'pending', requiresRefeed: true, refeedConfirmed: false }]
      : [{ artifactId: artifact.id, phase: 'fronts', state: 'pending' }]);
    const queued = !!row.queue_requested && printCapabilities(row.user_id).canQueue;
    assertActive();
    assertPrintStorageCapacity();
    run(`UPDATE print_jobs SET state = ?, manifest_json = ?, manifest_sha256 = ?, steps_json = ?, progress_json = NULL,
      queued_at = ?, expires_at = ?, updated_at = ?, error = ? WHERE id = ? AND state = 'preparing'`,
    [queued ? 'queued' : 'ready', bytes, hash, json(steps), queued ? now() : null,
      retentionExpiry(), now(),
      row.queue_requested && !queued ? 'PDF ready; household printing authorization is no longer available' : null, row.id]);
    if (get("SELECT name FROM sqlite_master WHERE type='table' AND name='manasync_pending_proxy_plans'")) {
      void import('./pendingProxyPlans.js').then(async bridge => {
        await bridge.stagePreparedPrintJob(row.user_id,row.id);
        await bridge.processPendingProxyPlans();
      }).catch(error => console.error('[PrintQueue] ManaSync pending plan staging failed:',error.message));
    }
  } catch (error) {
    rmSync(jobDir(row.id), { recursive: true, force: true });
    run("UPDATE print_jobs SET state = 'failed', error = ?, updated_at = ?, completed_at = ?, expires_at = ? WHERE id = ? AND state = 'preparing'", [error.message, now(), now(), retentionExpiry(), row.id]);
  } finally {
    controllers.delete(row.id); workerActive = false; triggerWorker(resumeDelay);
  }
}

export function queuePrintJob(userId, deckId, id) {
  assertCanQueue(userId);
  const row = ownerJob(userId, deckId, id);
  if (row.state === 'queued') return formatPrintJob(row);
  if (row.state !== 'ready') throw printError('Only a ready PDF can be queued. Reprints require a new job.', 409);
  if (row.expires_at <= now()) throw printError('These PDFs have expired. Prepare a new job.', 410);
  for (const artifact of parse(row.manifest_json).artifacts) verifiedPrintArtifact(row, artifact.id);
  run("UPDATE print_jobs SET state = 'queued', queue_requested = 1, queued_at = ?, updated_at = ? WHERE id = ?", [now(), now(), id]);
  return getOwnedPrintJob(userId, deckId, id);
}
export function cancelPrintJob(userId, deckId, id) {
  const row = ownerJob(userId, deckId, id);
  if (!['preparing', 'ready', 'queued', 'claimed', 'canceled'].includes(row.state) || parse(row.steps_json).some(step => ['submitting', 'submitted', 'uncertain'].includes(step.state))) {
    throw printError('A spooler submission may exist. Reconcile or cancel it at the print station first.', 409);
  }
  controllers.get(id)?.abort();
  run("UPDATE print_jobs SET state = 'canceled', queue_requested = 0, updated_at = ?, completed_at = ?, expires_at = ? WHERE id = ?", [now(), now(), retentionExpiry(), id]);
  return getOwnedPrintJob(userId, deckId, id);
}

export function verifiedPrintArtifact(row, artifactId) {
  if (!row.manifest_json || row.state === 'expired' || (!NEVER_EXPIRE.includes(row.state) && row.expires_at && row.expires_at <= now())) throw printError('PDF is unavailable or expired', 410);
  const manifest = parse(row.manifest_json);
  if (sha256(row.manifest_json) !== row.manifest_sha256) throw printError('Print manifest checksum mismatch', 409);
  const artifact = manifest.artifacts.find(item => item.id === artifactId);
  if (!artifact) throw printError('PDF artifact not found', 404);
  const path = resolve(jobDir(row.id), artifact.fileName);
  if (!path.startsWith(resolve(jobDir(row.id)) + sep) || !existsSync(path)) throw printError('PDF artifact is missing', 410);
  const actualPath = realpathSync(path);
  if (!actualPath.startsWith(realpathSync(jobDir(row.id)) + sep)) throw printError('Invalid PDF artifact path', 409);
  const size = statSync(actualPath).size;
  if (size > MAX_OUTPUT_BYTES || size !== artifact.size || hashPdf(actualPath).hash !== artifact.sha256) throw printError('PDF artifact checksum mismatch', 409);
  return { path: actualPath, ...artifact };
}
export const ownedPrintArtifact = (userId, deckId, id, artifactId) => verifiedPrintArtifact(ownerJob(userId, deckId, id), artifactId);

export function ownedPrintManifest(userId, deckId, id) {
  const row = ownerJob(userId, deckId, id);
  if (!row.manifest_json) throw printError('Print manifest is not ready', 409);
  if (sha256(row.manifest_json) !== row.manifest_sha256) throw printError('Print manifest checksum mismatch', 409);
  return parse(row.manifest_json);
}
export function expireOwnedPrintArtifacts(userId, deckId, id) {
  const row = ownerJob(userId, deckId, id);
  if (NEVER_EXPIRE.includes(row.state)) throw printError('Active print artifacts must be kept until the job is canceled or reconciled', 409);
  rmSync(jobDir(id), { recursive: true, force: true });
  run("UPDATE print_jobs SET state = 'expired', updated_at = ? WHERE id = ?", [now(), id]);
  return getOwnedPrintJob(userId, deckId, id);
}

export function cleanupPrintArtifacts() {
  for (const row of all("SELECT * FROM print_jobs WHERE datetime(COALESCE(expires_at, datetime(updated_at, '+7 days'))) <= datetime('now')")) {
    if (NEVER_EXPIRE.includes(row.state) || row.state === 'expired') continue;
    rmSync(jobDir(row.id), { recursive: true, force: true });
    run("UPDATE print_jobs SET state = 'expired', updated_at = ? WHERE id = ?", [now(), row.id]);
  }
  const retained = all("SELECT manifest_json FROM print_jobs WHERE manifest_json IS NOT NULL AND state != 'expired'")
    .map(row => parse(row.manifest_json)?.generatorRuntimeVersion).filter(Boolean);
  void Promise.resolve().then(() => {
    // Startup refresh owns the runtime lock; pruning can wait for the next pass.
    if (!getPrintGeneratorStatus().updating) return prunePrintGenerator({ retainVersions: [...new Set(retained)] });
  })
    .catch(error => console.error('[PrintQueue] Runtime retention cleanup failed:', error.message));
}

export function purgeUserPrintJobs(userId) {
  const rows = all('SELECT * FROM print_jobs WHERE user_id = ?', [userId]);
  if (rows.some(row => PHYSICAL_STATES.includes(row.state) || parse(row.steps_json).some(step => ['submitting', 'submitted', 'uncertain'].includes(step.state)))) {
    throw printError('Reconcile active print submissions at the household station before deleting this account', 409);
  }
  for (const row of rows) {
    controllers.get(row.id)?.abort();
    runTransaction([
      { sql: 'DELETE FROM print_job_events WHERE job_id = ?', params: [row.id] },
      { sql: 'DELETE FROM print_jobs WHERE id = ?', params: [row.id] },
    ]);
    rmSync(jobDir(row.id), { recursive: true, force: true });
  }
  // Retained confirmation artwork outlives job expiry, but not account deletion.
  rmSync(join(dataDir, 'manasync-artwork', String(userId)), { recursive: true, force: true });
}

export function assertStationArtifactCapacity(row, maxArtifacts) {
  if (!Number.isSafeInteger(maxArtifacts) || maxArtifacts < 1 || maxArtifacts > 37) {
    throw printError('maxArtifacts must be an integer between 1 and 37', 400);
  }
  const artifacts = parse(row.manifest_json)?.artifacts;
  if (!Array.isArray(artifacts)) throw printError('Print job manifest has no artifacts', 409);
  if (artifacts.length > maxArtifacts) {
    throw printError(`Upgrade the Mac print companion to continue this job: it has ${artifacts.length} PDF artifacts, but this companion supports ${maxArtifacts}.`, 409);
  }
}
export function claimPrintJob({ maxArtifacts = 37 } = {}) {
  let row = all(`SELECT * FROM print_jobs WHERE station_id = ? AND state IN (${ACTIVE_STATES.map(() => '?').join(',')}) ORDER BY queued_at, created_at, id LIMIT 1`, [STATION_ID, ...ACTIVE_STATES])[0];
  if (row) assertStationArtifactCapacity(row, maxArtifacts);
  if (row && row.state === 'claimed' && parse(row.steps_json).every(step => step.state === 'pending') && !printCapabilities(row.user_id).canQueue) {
    run("UPDATE print_jobs SET state = 'ready', queue_requested = 0, station_id = NULL, claim_nonce = NULL, error = ?, updated_at = ? WHERE id = ?", ['Printing authorization was revoked before submission', now(), row.id]);
    row = null;
  }
  if (row) {
    if (row.state === 'claimed') {
      run('UPDATE print_jobs SET lease_expires_at = ? WHERE id = ?', [leaseExpiry(), row.id]);
      row.lease_expires_at = leaseExpiry();
    }
    return formatPrintJob(row, true);
  }
  while ((row = get("SELECT * FROM print_jobs WHERE state = 'queued' ORDER BY queued_at, created_at, id LIMIT 1"))) {
    if (!printCapabilities(row.user_id).canQueue) {
      run("UPDATE print_jobs SET state = 'ready', queue_requested = 0, error = ?, updated_at = ? WHERE id = ?", ['Printing authorization was revoked; PDF remains available to its owner', now(), row.id]);
      continue;
    }
    // Check compatibility before hashing PDFs or creating a durable claim. Older
    // companions can upgrade without trapping this FIFO job in claimed state.
    assertStationArtifactCapacity(row, maxArtifacts);
    for (const artifact of parse(row.manifest_json).artifacts) verifiedPrintArtifact(row, artifact.id);
    run("UPDATE print_jobs SET state = 'claimed', station_id = ?, claim_nonce = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'",
      [STATION_ID, crypto.randomBytes(24).toString('hex'), leaseExpiry(), now(), row.id]);
    return formatPrintJob(get('SELECT * FROM print_jobs WHERE id = ?', [row.id]), true);
  }
  return null;
}
export function stationPrintJob(id) {
  const row = get('SELECT * FROM print_jobs WHERE id = ? AND station_id = ?', [id, STATION_ID]);
  if (!row) throw printError('Station print job not found', 404);
  return row;
}

export function reportPrintJob(id, event) {
  const row = stationPrintJob(id);
  safeId(event.eventId, 'eventId');
  if (typeof event.claimToken !== 'string' || !crypto.timingSafeEqual(Buffer.from(sha256(event.claimToken)), Buffer.from(sha256(claimToken(row))))) throw printError('Invalid job claim', 403);
  const eventHash = sha256(json(event));
  const previous = get('SELECT * FROM print_job_events WHERE job_id = ? AND event_id = ?', [id, event.eventId]);
  if (previous) {
    if (previous.request_hash !== eventHash) throw printError('This event ID was already used for a different station report', 409);
    return { job: formatPrintJob(row, true), replayed: true };
  }
  if (typeof event.detail === 'string' && event.detail.length > 2000) throw printError('Station detail is too long');
  if (event.spoolerId !== undefined && (typeof event.spoolerId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(event.spoolerId))) throw printError('Invalid spooler job ID');
  const steps = parse(row.steps_json), step = steps.find(item => item.artifactId === event.artifactId && item.phase === event.phase);
  const next = steps.find(item => item.state !== 'completed');
  let state = row.state, error = row.error;
  if (['canceled', 'expired', 'failed', 'completed'].includes(row.state) && event.state !== 'reconciled') throw printError('This print job is no longer active', 409);
  if (event.state === 'heartbeat') {
    // A heartbeat may renew a claim but never changes a physical outcome.
  } else if (event.state === 'submitting') {
    if (row.lease_expires_at <= now()) throw printError('Claim lease expired; renew it before starting submission', 409);
    if (!printCapabilities(row.user_id).canQueue) throw printError('Printing authorization was revoked', 403);
    if (!step || step !== next || step.state !== 'pending' || !['claimed', 'submitted'].includes(row.state)) throw printError('This pass is not eligible for a new submission', 409);
    if (step.requiresRefeed && !step.refeedConfirmed) throw printError('An operator must confirm the paper flip/refeed before printing backs', 409);
    verifiedPrintArtifact(row, step.artifactId);
    Object.assign(step, { state: 'submitting', submittingAt: now(), submissionEventId: event.eventId });
    state = 'submitting'; error = null;
  } else if (event.state === 'submitted') {
    if (!step || !['submitting', 'uncertain'].includes(step.state) || !event.spoolerId) throw printError('A submission intent and spooler ID are required', 409);
    Object.assign(step, { state: 'submitted', spoolerId: event.spoolerId, submittedAt: now() }); state = 'submitted'; error = null;
  } else if (event.state === 'completed') {
    if (!step || step.state !== 'submitted' || !event.spoolerId || step.spoolerId !== event.spoolerId) throw printError('Completion must match the acknowledged spooler job', 409);
    Object.assign(step, { state: 'completed', completedAt: now() });
    const remaining = steps.find(item => item.state !== 'completed');
    state = !remaining ? 'completed' : remaining.requiresRefeed && !remaining.refeedConfirmed ? 'awaiting_refeed' : 'claimed';
    error = null;
  } else if (event.state === 'awaiting_refeed') {
    if (!next?.requiresRefeed || next.refeedConfirmed || steps.some(item => ['submitting', 'submitted'].includes(item.state))) throw printError('This job is not ready for refeed', 409);
    state = 'awaiting_refeed';
  } else if (event.state === 'refeed') {
    const front = steps.find(item => item.artifactId === event.artifactId && item.phase === 'fronts');
    if (state !== 'awaiting_refeed' || !step || step !== next || step.phase !== 'backs'
      || !step.requiresRefeed || step.refeedConfirmed || step.state !== 'pending' || front?.state !== 'completed') {
      throw printError('This exact back pass is not waiting for a paper refeed after completed fronts', 409);
    }
    Object.assign(step, { refeedConfirmed: true, refeedAt: now() }); state = 'claimed';
  } else if (event.state === 'uncertain') {
    if (!step || !['submitting', 'submitted', 'uncertain'].includes(step.state)) throw printError('No submission exists to reconcile', 409);
    Object.assign(step, { state: 'uncertain', detail: event.detail || 'Submission outcome unknown' }); state = 'uncertain'; error = step.detail;
  } else if (event.state === 'failed') {
    if (steps.some(item => ['submitting', 'uncertain'].includes(item.state))) throw printError('Submission may have happened; report uncertain and reconcile instead', 409);
    if (steps.some(item => item.state === 'submitted' && (item !== step || event.spoolerId !== item.spoolerId))) throw printError('A failed spooler outcome must identify its acknowledged job', 409);
    const physicalAttempt = steps.some(item => ['submitted', 'completed'].includes(item.state));
    if (physicalAttempt) {
      if (!step) throw printError('Identify the failed pass so its paper handling can be reconciled', 409);
      Object.assign(step, { state: 'uncertain', spoolerOutcome: 'failed', detail: event.detail || 'Spooler failed; paper clearance required' });
      state = 'uncertain'; error = 'The printer may contain partial output. An operator must inspect and clear the paper before releasing this job.';
    } else {
      if (step) Object.assign(step, { state: 'failed', detail: event.detail || 'Station reported failure' });
      state = 'failed'; error = event.detail || 'Station reported failure';
    }
  } else if (event.state === 'reconciled') {
    if (!step || !['submitting', 'uncertain', 'submitted'].includes(step.state) || !event.detail) throw printError('Reconciliation requires a disputed pass and an operator explanation', 409);
    if (event.resolution === 'abandoned' && event.paperCleared === true) {
      Object.assign(step, { abandonedFrom: step.state, state: 'failed', detail: event.detail, reconciledAt: now() }); state = 'failed';
    } else if (event.resolution === 'not-submitted') {
      Object.assign(step, { state: 'pending', detail: event.detail, spoolerId: null, reconciledAt: now() }); state = 'claimed';
    } else if (['submitted', 'completed'].includes(event.resolution) && event.spoolerId) {
      Object.assign(step, { state: event.resolution, detail: event.detail, spoolerId: event.spoolerId, reconciledAt: now() });
      const remaining = steps.find(item => item.state !== 'completed');
      state = event.resolution === 'submitted' ? 'submitted' : !remaining ? 'completed' : remaining.requiresRefeed && !remaining.refeedConfirmed ? 'awaiting_refeed' : 'claimed';
    } else throw printError('Choose a verified reconciliation outcome and spooler ID where applicable');
    error = null;
  } else throw printError('Unsupported station event');
  runTransaction([
    { sql: `UPDATE print_jobs SET state = ?, steps_json = ?, error = ?, lease_expires_at = ?, updated_at = ?, completed_at = ?, expires_at = ? WHERE id = ?`,
      params: [state, json(steps), error, leaseExpiry(), now(), ['completed', 'failed'].includes(state) ? now() : row.completed_at, ['completed', 'failed'].includes(state) ? retentionExpiry() : row.expires_at, id] },
    { sql: 'INSERT INTO print_job_events (job_id, event_id, request_hash, event_json, created_at) VALUES (?, ?, ?, ?, ?)',
      params: [id, event.eventId, eventHash, json({ ...event, claimToken: undefined }), now()] },
  ]);
  return { job: formatPrintJob(get('SELECT * FROM print_jobs WHERE id = ?', [id]), true), replayed: false };
}
