/** Durable preparation and household station state machine. No shell/printer commands. */
import crypto from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { get, all, run, runTransaction } from '../db.js';
import { buildPrintPlan, publicPrintPlan, printError, sha256 } from './printQueuePlan.js';
import { frozenManifest, inspectFrozenPrintArtwork, prepareFrozenPrintImages, preparePrintImages } from './printQueueImages.js';
import { hashPrintPdf, printFileFingerprint } from './printPdfHash.js';
import { generatePrintPdfs, getPrintGeneratorStatus, PRINT_RECIPES, prunePrintGenerator } from './printGenerator.js';
import { DEFERRED_BACKS_WORKFLOW, DOUBLE_FACED_FIRST, ACTIVE_PRINT_STATES, PRINT_TERMINAL_STATES, readSteps, readBackRequest, isDeferred, finishedStep, nextPrintStep, settledPrintState, workflowSummary, paperClearanceId, missingCancellationStep } from './printWorkflow.js';
import { queuedPrintNotificationStatement } from './printQueueNotifications.js';
import { discordPrintCommandRejection } from './discordPrintCommandAuthorization.js';
import { DAHLE_A4_PRESET, LEGACY_STATION_PAPER, NEW_PRINT_PAPER_SIZES, NEW_PRINT_PRESETS, PRINT_PAPER_RECIPES, PRINT_PRESETS, dahleGuideOptions, newPrintPaperSelection, printJobPaper, printPaperSelection, stationCanPrintPaper } from './printPaper.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = dirname(process.env.DB_PATH || join(here, '..', 'data', 'cardlistcompare.db'));
export const PRINT_JOBS_DIR = process.env.PRINT_JOBS_DIR || join(dataDir, 'print-jobs');
export const PRINT_RETENTION_DAYS = 7;
export const MAX_PRINT_JOB_BYTES = 2 * 1024 * 1024 * 1024;
// A six-card layout can have 42 back-side packets and a separate ordinary PDF.
export const MAX_PRINT_ARTIFACTS = 43;
// Includes the retained job, duplicate PDF merge parts, and one decoded chunk's
// source copies. Preparation runs serially, so only one allowance is reserved.
export const PRINT_WORKING_RESERVE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const MANIFEST_RESERVE_BYTES = 1024 * 1024;
const STORAGE_MAX_BYTES = Math.max(1, Number(process.env.PRINT_STORAGE_MAX_MB) || 10240) * 1024 * 1024;
const LEASE_MS = 120000;
const LEASE_RENEW_THRESHOLD_MS = LEASE_MS / 2;
const STATION_ID = 'household';
const ACTIVE_STATES = ACTIVE_PRINT_STATES;
const PHYSICAL_STATES = ['submitting', 'submitted', 'awaiting_refeed', 'awaiting_paper_reset', 'uncertain'];
const NEVER_EXPIRE = ['preparing', 'queued', 'backs_pending', ...ACTIVE_STATES];
let workerActive = false;
let timer;
let lastClaim = Promise.resolve();
let activeAlternateReviews = 0;
const controllers = new Map();
const now = () => new Date().toISOString();
const retentionExpiry = () => new Date(Date.now() + PRINT_RETENTION_DAYS * 86400000).toISOString();
const leaseExpiry = () => new Date(Date.now() + LEASE_MS).toISOString();
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value || 'null');
const jobDir = id => join(PRINT_JOBS_DIR, id);
const retainedArtworkDir = userId => join(dataDir, 'manasync-artwork', String(userId));

export function printCapabilities(userId) {
  const token = process.env.PRINT_STATION_TOKEN || '';
  const stationConfigured = token.length >= 32;
  const user = get('SELECT id, is_admin, suspended FROM users WHERE id = ?', [userId]);
  const allowed = (process.env.PRINT_ALLOWED_USER_IDS || '').split(',').map(value => Number(value.trim())).filter(id => Number.isSafeInteger(id) && id > 0);
  return {
    stationConfigured, canQueue: !!(stationConfigured && user && !user.suspended && (user.is_admin || allowed.includes(userId))),
    recipeId: PRINT_PAPER_RECIPES.letter, paperSizes: NEW_PRINT_PAPER_SIZES,
    printPresets: NEW_PRINT_PRESETS, retentionDays: PRINT_RETENTION_DAYS, maxCopies: 250,
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
  const row = get('SELECT * FROM print_jobs WHERE id = ? AND user_id = ? AND tracked_deck_id IS ?', [id, userId, deckId]);
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
    ...(artifact.doubleFacedCardCount === undefined ? {} : { doubleFacedCardCount: artifact.doubleFacedCardCount }),
    ...(artifact.label ? { label: artifact.label } : {}),
    ...(artifact.packetIndex ? { packetIndex: artifact.packetIndex, packetCount: artifact.packetCount } : {}),
    ...(artifact.printedIdentification ? { printedIdentification: artifact.printedIdentification } : {}),
    ...(artifact.pageLabels ? { pageLabels: artifact.pageLabels } : {}),
    frontPages: artifact.kind === 'dfc' ? Array.from({ length: artifact.sheetCount }, (_, n) => n * 2 + 1) : Array.from({ length: artifact.pageCount }, (_, n) => n + 1),
    backPages: artifact.kind === 'dfc' ? Array.from({ length: artifact.sheetCount }, (_, n) => n * 2 + 2) : [],
    downloadUrl: station
      ? `/api/print-station/jobs/${row.id}/artifacts/${artifact.id}`
      : row.tracked_deck_id === null ? `/api/print-lists/jobs/${row.id}/artifacts/${artifact.id}`
        : `/api/decks/${row.tracked_deck_id}/print-jobs/${row.id}/artifacts/${artifact.id}`,
  };
}
function alternateLayoutOf(row, plan) {
  return row.source_job_id ? { id: row.source_job_id, manifestSha256: plan.sourceManifestSha256 } : undefined;
}
export function formatPrintJob(row, station = false) {
  const plan = parse(row.plan_json), manifest = parse(row.manifest_json);
  const publicPlan = publicPrintPlan(plan);
  const value = {
    id: row.id, state: row.state, mode: plan.mode, deckId: row.tracked_deck_id, deckName: plan.deckName,
    requesterId: row.user_id, totalCopies: plan.totalCopies, artSource: plan.artSource,
    registrationMarks: plan.registrationMarks !== false,
    ...(plan.dahleAlignmentMarks === true ? { dahleAlignmentMarks: true } : {}),
    ...(plan.dahleCutGuides === true ? { dahleCutGuides: true } : {}),
    printingOverrideCount: (plan.resolvedCards || []).filter(card => card.requestedScryfallId).length,
    source: publicPlan.source, target: publicPlan.target,
    ...(plan.list ? { list: publicPlan.list } : {}),
    ...(plan.comparison ? { comparison: publicPlan.comparison } : {}),
    ...(row.source_job_id ? { alternateLayoutOf: alternateLayoutOf(row, plan), confirmationJobId: plan.confirmationJobId || row.source_job_id } : {}),
    ...(plan.sheetPacking ? { sheetPacking: plan.sheetPacking, requiresMixedPrintSheets: true } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
    queueOnReady: !!row.queue_requested, error: row.error, proxyStagingError: row.proxy_staging_error || null, progress: parse(row.progress_json),
    ...printJobPaper(plan, manifest), manifestSha256: row.manifest_sha256,
    artifacts: row.state === 'expired' ? [] : (manifest?.artifacts || []).map(artifact => artifactRecord(row, artifact, station)),
    steps: parse(row.steps_json) || [],
    ...workflowSummary(row),
  };
  if (station) Object.assign(value, { claimToken: claimToken(row), leaseExpiresAt: row.lease_expires_at });
  return value;
}
export const getOwnedPrintJob = (userId, deckId, id) => formatPrintJob(ownerJob(userId, deckId, id));
export function listPrintJobs(userId, deckId) {
  return all('SELECT * FROM print_jobs WHERE user_id = ? AND tracked_deck_id IS ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId, deckId]).map(row => formatPrintJob(row));
}

function replayPrintRequest(userId, requestKey, requestHash) {
  const existing = get('SELECT * FROM print_jobs WHERE user_id = ? AND request_key = ?', [userId, requestKey]);
  if (!existing) return null;
  if (existing.request_hash !== requestHash) throw printError('This request key already belongs to a different print request', 409);
  return { job: formatPrintJob(existing), isExisting: true };
}

function savePrintRequest(userId, deckId, plan, { requestKey, requestHash, queueOnReady = false, sourceJobId = null }) {
  const pending = get("SELECT COUNT(*) AS count FROM print_jobs WHERE user_id = ? AND state = 'preparing'", [userId]);
  if (pending.count >= 2) throw printError('Two PDFs are already being prepared for your account. Retry when one finishes generating.', 429);
  if (get("SELECT COUNT(*) AS count FROM print_jobs WHERE state = 'preparing'").count >= 10) throw printError('The PDF preparation queue is full', 429);
  // An alternate-layout request must leave the source and its files untouched.
  if (!sourceJobId) cleanupPrintArtifacts();
  if (totalStorage() + PRINT_WORKING_RESERVE_BYTES > STORAGE_MAX_BYTES) throw printError('Print storage lacks the 5 GiB working allowance. Remove or expire completed artifacts before preparing more PDFs.', 507);
  const id = crypto.randomUUID(), timestamp = now();
  const requester = get('SELECT username FROM users WHERE id = ?', [userId]);
  plan.requesterName = (requester?.username || 'Unknown requester').slice(0, 120);
  runTransaction([{ sql: `INSERT INTO print_jobs (id, user_id, tracked_deck_id, request_key, request_hash, plan_json, queue_requested, created_at, updated_at, source_job_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [id, userId, deckId, requestKey, requestHash, json(plan), queueOnReady ? 1 : 0, timestamp, timestamp, sourceJobId] }]);
  triggerWorker();
  return { job: getOwnedPrintJob(userId, deckId, id), isExisting: false };
}

export async function createPrintJob(userId, deckId, request, assertQueuePaper = () => {}) {
  const requestKey = safeId(request.idempotencyKey, 'idempotencyKey');
  const { paperSize, printPreset } = printPaperSelection(request.paperSize, request.printPreset);
  if (request.registrationMarks !== undefined && typeof request.registrationMarks !== 'boolean') {
    throw printError('registrationMarks must be true or false');
  }
  const registrationMarks = printPreset !== DAHLE_A4_PRESET && request.registrationMarks !== false;
  const guides = dahleGuideOptions(printPreset, request);
  if (typeof request.expectedPlanHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedPlanHash)) throw printError('Preview the print plan before creating a job');
  if (request.queueOnReady !== undefined && typeof request.queueOnReady !== 'boolean') throw printError('queueOnReady must be true or false');
  const requestHash = sha256(json({ deckId, expectedPlanHash: request.expectedPlanHash, queueOnReady: !!request.queueOnReady,
    ...(paperSize === 'letter' ? {} : { paperSize }), ...(printPreset ? { printPreset } : {}),
    ...(registrationMarks ? {} : { registrationMarks }), ...guides }));
  const existing = replayPrintRequest(userId, requestKey, requestHash);
  if (existing) return existing;
  // New plans enforce current layouts. Previously accepted requests replay above.
  const plan = await buildPrintPlan(userId, deckId, request);
  // Two concurrent requests can resolve metadata together. Recheck the durable
  // receipt after that await before inserting or consuming pending-job capacity.
  const concurrent = replayPrintRequest(userId, requestKey, requestHash);
  if (concurrent) return concurrent;
  if (plan.planHash !== request.expectedPlanHash) throw printError('Snapshots or artwork changed after preview. Review a fresh plan.', 409);
  if (!plan.totalCopies) throw printError('This comparison has no copies to print');
  if (!plan.readyToGenerate) throw printError(`Review the missing or unsupported artwork before generating: ${plan.resolvedCards.filter(card => card.errors.length).map(card => `${card.displayName}: ${card.errors.join('; ')}`).join(', ')}`);
  if (request.queueOnReady) {
    assertStationLayout(plan);
    assertCanQueue(userId);
    assertQueuePaper(printJobPaper(plan));
  }
  // Sheet decoration is chosen at generation time. Keep the reviewed card plan hash stable.
  if (!registrationMarks) plan.registrationMarks = false;
  return savePrintRequest(userId, deckId, plan, { requestKey, requestHash, queueOnReady: !!request.queueOnReady });
}

function alternateLayoutInput(request, creating = false) {
  const allowed = ['paperSize', 'printPreset', 'registrationMarks', 'dahleAlignmentMarks', 'dahleCutGuides',
    ...(creating ? ['expectedPlanHash', 'idempotencyKey'] : [])];
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !allowed.includes(key))) {
    throw printError('Supply only the alternate paper layout and its marks');
  }
  if (request.paperSize === undefined) throw printError('Select a paper layout for the alternate PDF');
  const select = creating ? printPaperSelection : newPrintPaperSelection;
  const selection = select(request.paperSize, request.printPreset);
  if (request.registrationMarks !== undefined && typeof request.registrationMarks !== 'boolean') throw printError('registrationMarks must be true or false');
  const guides = dahleGuideOptions(selection.printPreset, request);
  return { ...selection, registrationMarks: selection.printPreset !== DAHLE_A4_PRESET && request.registrationMarks !== false,
    ...guides };
}

function buildAlternateLayout(source, selection) {
  const manifest = frozenManifest(source);
  const { paperSize, printPreset, recipeId, registrationMarks } = selection;
  const doubleFacedCopies = manifest.copies.filter(copy => copy.back).length;
  const ordinaryCopies = manifest.copies.length - doubleFacedCopies;
  const { planHash: _oldHash, paperSize: _oldPaper, printPreset: _oldPreset, registrationMarks: _oldMarks,
    dahleAlignmentMarks: _oldAlignmentMarks, dahleCutGuides: _oldCutGuides, sheetPacking: _oldPacking, ...frozenCards } = manifest.plan;
  const planHash = sha256(json({ type: 'alternate-layout', sourceJobId: source.id, sourceManifestSha256: source.manifest_sha256, ...selection }));
  const plan = { ...frozenCards, paperSize, ...(printPreset ? { printPreset } : {}), registrationMarks,
    ...dahleGuideOptions(printPreset, selection),
    ...(ordinaryCopies && doubleFacedCopies ? { sheetPacking: DOUBLE_FACED_FIRST } : {}),
    totalCopies: manifest.copies.length, ordinaryCopies, doubleFacedCopies, readyToGenerate: true, targetRecipeId: recipeId,
    sourceManifestSha256: source.manifest_sha256, confirmationJobId: source.source_job_id
      ? manifest.plan.confirmationJobId || source.source_job_id : source.id, planHash };
  const capacity = PRINT_PRESETS[printPreset]?.cardsPerSheet ?? PRINT_RECIPES[paperSize].cardsPerSheet;
  // Mixed sheets fill unused back-packet positions with ordinary fronts.
  return { plan, layout: { frontSheets: Math.ceil(plan.totalCopies / capacity), backSheets: Math.ceil(doubleFacedCopies / capacity) } };
}

const frozenPrintingKey = card => json([card.displayName, card.setCode, card.collectorNumber, card.scryfallId]);

function alternateReviewedCards(copies, sourceCards, failures) {
  const sourceByPrinting = new Map((Array.isArray(sourceCards) ? sourceCards : []).map(card => [frozenPrintingKey(card), card]));
  const failuresByCopyFace = new Map(failures.flatMap(result => result.copyIds.map(id => [json([id, result.face]), result.reason])));
  const byArtwork = new Map();
  for (const copy of copies) {
    const printing = frozenPrintingKey(copy);
    const sides = copy.back ? ['front', 'back'] : ['front'];
    const key = json([printing, ...sides.map(side => {
      const image = copy[side];
      return [image?.source, image?.identifier, image?.sha256, image?.size];
    })]);
    let card = byArtwork.get(key);
    if (!card) {
      const original = sourceByPrinting.get(printing);
      const faces = sides.map((face, index) => ({ face,
        name: original?.faces?.find(value => value.face === face)?.name || original?.faceNames?.[index] || (face === 'front' ? copy.displayName : null),
        source: copy[face]?.source || null, identifier: copy[face]?.identifier || null, status: 'ready', error: null }));
      card = { selectionKey: sha256(key), displayName: copy.displayName, setCode: copy.setCode, collectorNumber: copy.collectorNumber,
        scryfallId: copy.scryfallId, oracleId: copy.oracleId, isDFC: !!copy.back, faces, quantity: 0 };
      byArtwork.set(key, card);
    }
    card.quantity++;
    for (const face of card.faces) {
      const error = failuresByCopyFace.get(json([copy.id, face.face]));
      if (error) Object.assign(face, { status: 'error', error });
    }
  }
  return [...byArtwork.values()];
}

export async function reviewAlternatePrintLayout(userId, deckId, sourceJobId, request, signal) {
  const source = ownerJob(userId, deckId, sourceJobId);
  const { plan, layout } = buildAlternateLayout(source, alternateLayoutInput(request));
  if (activeAlternateReviews >= 4) throw printError('Other artwork reviews are in progress. Try again shortly.', 429);
  const timeout = AbortSignal.timeout(90_000);
  activeAlternateReviews++;
  try {
    const { copies, failures } = await inspectFrozenPrintArtwork(source, jobDir(sourceJobId), retainedArtworkDir(userId),
      signal ? AbortSignal.any([signal, timeout]) : timeout);
    const current = ownerJob(userId, deckId, sourceJobId);
    if (current.manifest_sha256 !== source.manifest_sha256 || current.manifest_json !== source.manifest_json) {
      throw printError('The saved batch manifest changed during review. Open the batch again.', 409);
    }
    const artworkFailures = failures.map(({ copyIds: _copyIds, ...failure }) => failure);
    const reviewed = publicPrintPlan({ ...plan, readyToGenerate: failures.length === 0, missingArtwork: artworkFailures,
      resolvedCards: alternateReviewedCards(copies, plan.resolvedCards, failures) });
    if (failures.length) delete reviewed.planHash;
    return { plan: reviewed,
      layout, artworkFailures, sourceJobId, sourceManifestSha256: source.manifest_sha256 };
  } catch (error) {
    if (timeout.aborted) throw printError('Exact artwork verification took too long. Try reviewing the layout again.', 503);
    throw error;
  } finally { activeAlternateReviews--; }
}

export function createAlternatePrintLayout(userId, deckId, sourceJobId, request) {
  const source = ownerJob(userId, deckId, sourceJobId);
  const { recipeId: _recipeId, ...layout } = alternateLayoutInput(request, true);
  const requestKey = safeId(request.idempotencyKey, 'idempotencyKey');
  if (typeof request.expectedPlanHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedPlanHash)) throw printError('Review the alternate layout before preparing its PDF');
  const requestHash = sha256(json({ type: 'alternate-layout', deckId, sourceJobId, expectedPlanHash: request.expectedPlanHash, ...layout }));
  const existing = replayPrintRequest(userId, requestKey, requestHash);
  if (existing) return existing;
  const { plan } = buildAlternateLayout(source, { ...newPrintPaperSelection(layout.paperSize, layout.printPreset),
    registrationMarks: layout.registrationMarks, ...dahleGuideOptions(layout.printPreset, layout) });
  if (plan.planHash !== request.expectedPlanHash) throw printError('The saved batch or requested layout changed. Review the alternate layout again.', 409);
  return savePrintRequest(userId, deckId, plan, { requestKey, requestHash, sourceJobId });
}

function assertRenderedArtwork(copies, images) {
  if (!Array.isArray(images) || images.length !== copies.length) throw printError('The PDF generator did not acknowledge every saved physical card copy', 409);
  const expected = new Map(copies.map(copy => [copy.id, copy]));
  for (const image of images) {
    const saved = expected.get(image?.id);
    if (!saved) throw printError('The PDF generator reported an unexpected physical card copy', 409);
    for (const face of ['front', 'back']) {
      if (!!image[face] !== !!saved[face] || image[face]?.sha256 !== saved[face]?.sha256) {
        throw printError(`Cannot regenerate PDFs. ${saved.displayName}, ${face}: the staged artwork changed during PDF generation`, 409);
      }
    }
    expected.delete(image.id);
  }
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
    const guides = dahleGuideOptions(plan.printPreset, plan);
    if (row.source_job_id && printJobPaper(plan).recipeId !== plan.targetRecipeId) {
      throw printError('The selected paper recipe changed. Open the source batch and review the layout again.', 409);
    }
    mkdirSync(jobDir(row.id), { recursive: true });
    const copies = row.source_job_id
      ? await prepareFrozenPrintImages(ownerJob(row.user_id, row.tracked_deck_id, row.source_job_id), jobDir(row.source_job_id),
        retainedArtworkDir(row.user_id), jobDir(row.id), progress, controller.signal, plan.sourceManifestSha256)
      : await preparePrintImages(plan, jobDir(row.id), progress);
    assertActive();
    const maxOutputBytes = MAX_PRINT_JOB_BYTES - totalStorage(jobDir(row.id)) - MANIFEST_RESERVE_BYTES;
    if (maxOutputBytes <= 0) throw printError('Source images exceed the print-job storage limit', 507);
    const generated = await generatePrintPdfs({
      paperSize: plan.paperSize ?? 'letter',
      ...(plan.printPreset ? { printPreset: plan.printPreset } : {}),
      ...(plan.sheetPacking ? { sheetPacking: plan.sheetPacking } : {}),
      ...(plan.registrationMarks === false ? { registrationMarks: false } : {}),
      ...guides,
      cards: copies.map(copy => ({
        id: copy.id, frontPath: copy.front.path, ...(copy.back ? { backPath: copy.back.path } : {}),
        ...(plan.printPreset === DAHLE_A4_PRESET ? { displayName: copy.displayName, frontSource: copy.front.source,
          ...(copy.back ? { backSource: copy.back.source } : {}) } : {}),
      })),
      outputDir: join(jobDir(row.id), 'output'), batchLabel: `CLC ${row.id.slice(0, 8)}`,
      requesterName: plan.requesterName || 'Unknown requester', batchName: plan.deckName,
      maxOutputBytes, signal: controller.signal, onProgress: progress,
    });
    assertActive();
    if ((generated.dahleAlignmentMarks ?? false) !== (guides.dahleAlignmentMarks === true)) {
      throw printError('The PDF generator did not confirm the requested Dahle alignment marks', 409);
    }
    if ((generated.dahleCutGuides ?? false) !== (guides.dahleCutGuides === true)) {
      throw printError('The PDF generator did not confirm the requested Dahle cut guides', 409);
    }
    if (row.source_job_id) {
      if (generated.recipe?.id !== plan.targetRecipeId) throw printError('The PDF generator returned a different paper recipe. Open the source batch and review the layout again.', 409);
      assertRenderedArtwork(copies, generated.images);
    }
    if (totalStorage(jobDir(row.id)) > MAX_PRINT_JOB_BYTES) throw printError('Generated job exceeds the 2 GiB storage limit', 507);
    let outputBytes = 0;
    if (!Array.isArray(generated.artifacts) || generated.artifacts.length > MAX_PRINT_ARTIFACTS) throw printError('Generator returned too many artifacts', 500);
    const artifactIds = new Set();
    const packets = generated.artifacts.filter(artifact => /^double-faced-\d{3}$/.test(artifact.id));
    const packetCapacity = PRINT_PRESETS[plan.printPreset]?.cardsPerSheet ?? 7;
    const mixed = plan.sheetPacking === DOUBLE_FACED_FIRST;
    if (mixed) {
      const expectedPackets = Math.ceil(plan.doubleFacedCopies / packetCapacity);
      const ordinaryLeft = Math.max(0, plan.totalCopies - expectedPackets * packetCapacity);
      const ordinary = generated.artifacts.at(-1);
      const ordinarySheets = Math.ceil(ordinaryLeft / packetCapacity);
      if (packets.length !== expectedPackets
        || generated.artifacts.length !== expectedPackets + (ordinaryLeft > 0 ? 1 : 0)
        || packets.some((packet, index) => {
          const expectedBacks = Math.min(packetCapacity, plan.doubleFacedCopies - index * packetCapacity);
          const expectedFronts = Math.min(packetCapacity, plan.totalCopies - index * packetCapacity);
          return generated.artifacts[index] !== packet || packet.doubleFacedCardCount !== expectedBacks || packet.cardCount !== expectedFronts;
        })
        || (ordinaryLeft > 0 && (ordinary.id !== 'fronts' || ordinary.kind !== 'ordinary'
          || ordinary.cardCount !== ordinaryLeft || ordinary.sheetCount !== ordinarySheets || ordinary.pageCount !== ordinarySheets))) {
        throw printError('Generated mixed sheet layout does not match the plan', 500);
      }
    }
    const artifacts = [], verifiedFiles = [];
    for (const artifact of generated.artifacts) {
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
          || artifact.cardCount < 1 || artifact.cardCount > packetCapacity
          || artifact.label !== `CLC ${row.id.slice(0, 8)} DFC ${index}/${packets.length}`) {
          throw printError('Generator returned an invalid double-sided packet', 500);
        }
      } else if (packets.length && artifact.kind === 'dfc') throw printError('Generator mixed packet and legacy double-sided groups', 500);
      const size = statSync(path).size; outputBytes += size;
      if (size > MAX_OUTPUT_BYTES || outputBytes > maxOutputBytes) throw printError('Generated PDFs exceed the artifact or job storage limit', 507);
      const verified = await hashPrintPdf(path, size);
      assertActive();
      if (!verified?.isPdf || verified.hash !== artifact.sha256 || !Number.isSafeInteger(artifact.pageCount) || artifact.pageCount < 1) throw printError('Generated PDF verification failed', 500);
      if (artifact.kind === 'dfc' && artifact.pageCount !== artifact.sheetCount * 2) throw printError('Double-faced PDF page pairing is incomplete', 500);
      const { path: _path, ...metadata } = artifact;
      artifacts.push({ ...metadata, size, sha256: verified.hash, fileName: relative(realpathSync(jobDir(row.id)), path) });
      verifiedFiles.push({ path, fingerprint: verified.fingerprint });
    }
    if (!artifacts.length || artifacts.reduce((count, artifact) => count + artifact.cardCount, 0) !== plan.totalCopies) throw printError('Generated PDF copy count does not match the plan', 500);
    const withoutPath = image => { const { path: _path, ...record } = image; return record; };
    const manifest = {
      version: 1, jobId: row.id, requesterId: row.user_id, createdAt: row.created_at, plan,
      ...(row.source_job_id ? { alternateLayoutOf: alternateLayoutOf(row, plan) } : {}),
      ...guides,
      copies: copies.map(copy => ({ ...copy, front: withoutPath(copy.front), ...(copy.back ? { back: withoutPath(copy.back) } : {}) })),
      generatorRevision: generated.revision, generatorRuntimeVersion: generated.runtimeVersion, recipe: generated.recipe, artifacts, slots: generated.slots,
      images: generated.images || [], generatedAt: now(),
      ...(generated.printedIdentification ? { printedIdentification: generated.printedIdentification } : {}),
    };
    printJobPaper(plan, manifest);
    const bytes = json(manifest), hash = sha256(bytes);
    if (Buffer.byteLength(bytes) > MANIFEST_RESERVE_BYTES) throw printError('Print manifest exceeds the storage limit', 507);
    verifiedFiles.forEach(assertUnchangedArtifact);
    writeFileSync(join(jobDir(row.id), 'manifest.json.tmp'), bytes, { flag: 'wx' });
    renameSync(join(jobDir(row.id), 'manifest.json.tmp'), join(jobDir(row.id), 'manifest.json'));
    const pairedSteps = artifacts.flatMap(artifact => artifact.kind === 'dfc'
      ? [{ artifactId: artifact.id, phase: 'fronts', state: 'pending' }, { artifactId: artifact.id, phase: 'backs', state: 'pending', requiresRefeed: true, refeedConfirmed: false }]
      : [{ artifactId: artifact.id, phase: 'fronts', state: 'pending' }]);
    const steps = mixed ? deferredStepOrder(pairedSteps) : pairedSteps;
    const queued = !row.source_job_id && !!row.queue_requested && printCapabilities(row.user_id).canQueue;
    assertActive();
    assertPrintStorageCapacity();
    const queuedAt = queued ? now() : null;
    runTransaction([{ sql: `UPDATE print_jobs SET state = ?, manifest_json = ?, manifest_sha256 = ?, steps_json = ?, workflow = ?, progress_json = NULL,
      queued_at = ?, expires_at = ?, updated_at = ?, error = ? WHERE id = ? AND state = 'preparing'`,
    params: [queued ? 'queued' : 'ready', bytes, hash, json(steps), mixed ? DEFERRED_BACKS_WORKFLOW : row.workflow, queuedAt,
      retentionExpiry(), now(),
      row.queue_requested && !queued ? 'PDF ready; household printing authorization is no longer available' : null, row.id] },
    ...(queued ? [queuedPrintNotificationStatement(row, queuedAt)] : [])]);
    if (!row.source_job_id && get("SELECT name FROM sqlite_master WHERE type='table' AND name='manasync_pending_proxy_plans'")) {
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

function assertStationLayout({ printPreset }) {
  if (printPreset === DAHLE_A4_PRESET) {
    throw printError('Download the Dahle punch PDF to print it at Actual Size.', 409);
  }
}

export async function queuePrintJob(userId, deckId, id, assertQueuePaper = () => {}) {
  assertCanQueue(userId);
  const row = ownerJob(userId, deckId, id);
  if (row.state === 'queued') return formatPrintJob(row);
  if (row.state !== 'ready') throw printError('Only a ready PDF can be queued. Reprints require a new job.', 409);
  if (row.expires_at <= now()) throw printError('These PDFs have expired. Prepare a new job.', 410);
  const paper = savedPrintJobPaper(row);
  assertStationLayout(paper);
  assertQueuePaper(paper);
  const files = [];
  for (const artifact of parse(row.manifest_json).artifacts) files.push(await verifiedPrintArtifact(row, artifact.id));
  const current = ownerJob(userId, deckId, id);
  assertCanQueue(userId);
  if (current.state === 'queued' && current.manifest_sha256 === row.manifest_sha256) return formatPrintJob(current);
  assertSamePhysicalState(row, current);
  if (current.expires_at <= now()) throw printError('These PDFs have expired. Prepare a new job.', 410);
  assertQueuePaper(paper);
  files.forEach(assertUnchangedArtifact);
  const queuedAt = now();
  runTransaction([
    { sql: "UPDATE print_jobs SET state = 'queued', queue_requested = 1, queued_at = ?, updated_at = ? WHERE id = ? AND state = 'ready'", params: [queuedAt, queuedAt, id] },
    queuedPrintNotificationStatement(row, queuedAt),
  ]);
  return getOwnedPrintJob(userId, deckId, id);
}
export function cancelPrintJob(userId, deckId, id) {
  const row = ownerJob(userId, deckId, id);
  if (row.state === 'canceled') return formatPrintJob(row);
  if (isDeferred(row)) return requestPrintCancellation(row, 'all');
  if (!['preparing', 'ready', 'queued', 'claimed'].includes(row.state) || parse(row.steps_json).some(step => step.state !== 'pending')) {
    throw printError('A spooler submission may exist. Reconcile or cancel it at the print station first.', 409);
  }
  controllers.get(id)?.abort();
  run("UPDATE print_jobs SET state = 'canceled', queue_requested = 0, updated_at = ?, completed_at = ?, expires_at = ? WHERE id = ?", [now(), now(), retentionExpiry(), id]);
  return getOwnedPrintJob(userId, deckId, id);
}

/** Called only after owner/admin authorization. Active physical work is canceled
 * by the native station, never by guessing a CUPS outcome in the container. */
export function requestPrintCancellation(row, scope = 'all') {
  if (!['all', 'backs'].includes(scope)) throw printError('Invalid print cancellation scope');
  if (row.state === 'canceled') return formatPrintJob(row);
  if (PRINT_TERMINAL_STATES.includes(row.state)) throw printError('This print batch has already finished', 409);
  const steps = readSteps(row), targets = steps.filter(step => !finishedStep(step) && (scope === 'all' || step.phase === 'backs'));
  if (!targets.length && row.state !== 'preparing') throw printError('No unfinished passes remain to cancel', 409);
  if (row.cancel_requested) {
    if (row.cancel_requested !== scope && scope !== 'all') throw printError('This batch already has a cancellation pending', 409);
    if (row.cancel_requested === scope) return formatPrintJob(row);
  }
  const reserved = !!readBackRequest(row) && ACTIVE_STATES.includes(row.state);
  const reloadedBack = targets.some(step => step.phase === 'backs' && step.requiresRefeed && step.refeedConfirmed);
  const physical = targets.some(step => ['submitting', 'submitted', 'uncertain'].includes(step.state));
  const activeAll = scope === 'all' && ACTIVE_STATES.includes(row.state) && steps.some(step => step.state !== 'pending');
  if (reserved || reloadedBack || physical || activeAll) {
    run('UPDATE print_jobs SET cancel_requested = ?, cancel_request_id = ?, updated_at = ? WHERE id = ?', [scope, crypto.randomUUID(), now(), row.id]);
  } else {
    if (scope === 'all') controllers.get(row.id)?.abort();
    for (const step of targets) Object.assign(step, { state: 'canceled', canceledAt: now() });
    const state = scope === 'all' ? 'canceled' : settledPrintState(row, steps);
    // Canceling future backs during an in-flight front must not change its
    // submission state or lease. Only its future work is removed.
    const finalState = scope === 'backs' && ['ready', 'queued', 'submitting', 'submitted', 'uncertain'].includes(row.state) ? row.state : state;
    run('UPDATE print_jobs SET state = ?, steps_json = ?, back_request_json = NULL, cancel_requested = NULL, cancel_request_id = NULL, queue_requested = ?, updated_at = ?, completed_at = ?, expires_at = ? WHERE id = ?',
      [finalState, json(steps), scope === 'all' ? 0 : row.queue_requested, now(), PRINT_TERMINAL_STATES.includes(finalState) ? now() : row.completed_at,
        PRINT_TERMINAL_STATES.includes(finalState) ? retentionExpiry() : row.expires_at, row.id]);
  }
  return formatPrintJob(get('SELECT * FROM print_jobs WHERE id = ?', [row.id]));
}

export async function preparePrintBacks(row, artifactId, requesterId, assertRequest = () => {}) {
  if (!isDeferred(row) || row.state !== 'backs_pending' || row.cancel_requested) throw printError('This batch is not ready to schedule saved backs', 409);
  const request = readBackRequest(row);
  if (request) {
    if (request.artifactId === artifactId) return formatPrintJob(row);
    throw printError('Another packet from this batch is already requested', 409);
  }
  const steps = readSteps(row), back = steps.find(step => step.artifactId === artifactId && step.phase === 'backs');
  const front = steps.find(step => step.artifactId === artifactId && step.phase === 'fronts');
  if (!back || back.state !== 'pending' || front?.state !== 'completed') throw printError('Choose an unfinished back packet whose fronts are complete', 409);
  const file = await verifyStationArtifact(row, artifactId);
  const current = getPrintRow(row.id);
  assertRequest();
  if (current?.state === 'backs_pending' && readBackRequest(current)?.artifactId === artifactId) return formatPrintJob(current);
  assertSamePhysicalState(row, current);
  assertUnchangedArtifact(file);
  runTransaction([{ sql: 'UPDATE print_jobs SET back_request_json = ?, updated_at = ? WHERE id = ?',
    params: [json({ id: crypto.randomUUID(), artifactId, requestedAt: now(), requesterId }), now(), row.id] }]);
  return formatPrintJob(get('SELECT * FROM print_jobs WHERE id = ?', [row.id]));
}

function artifactFailure(message, status) {
  return Object.assign(printError(message, status), { artifactUnavailable: true });
}

function assertUnchangedArtifact(file) {
  try {
    if (printFileFingerprint(file.path) === file.fingerprint) return;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    throw artifactFailure('PDF artifact is missing', 410);
  }
  throw artifactFailure('PDF artifact changed during verification', 409);
}

const getPrintRow = id => get('SELECT * FROM print_jobs WHERE id = ?', [id]);
function samePhysicalState(old, current) {
  return !!current && ['id', 'state', 'user_id', 'tracked_deck_id', 'station_id', 'claim_nonce', 'workflow', 'steps_json',
    'manifest_sha256', 'manifest_json', 'expires_at', 'cancel_requested', 'cancel_request_id', 'back_request_json'].every(key => old[key] === current[key]);
}

function assertSamePhysicalState(old, current) {
  if (!samePhysicalState(old, current)) throw printError('This print batch changed during PDF verification. Refresh its status.', 409);
}

function assertArtifactAvailable(row) {
  if (!row.manifest_json || row.state === 'expired' || (!NEVER_EXPIRE.includes(row.state) && row.expires_at && row.expires_at <= now())) throw printError('PDF is unavailable or expired', 410);
}

export async function verifiedPrintArtifact(row, artifactId) {
  assertArtifactAvailable(row);
  const manifest = parse(row.manifest_json);
  if (sha256(row.manifest_json) !== row.manifest_sha256) throw printError('Print manifest checksum mismatch', 409);
  const artifact = manifest.artifacts.find(item => item.id === artifactId);
  if (!artifact) throw printError('PDF artifact not found', 404);
  const path = resolve(jobDir(row.id), artifact.fileName);
  if (!path.startsWith(resolve(jobDir(row.id)) + sep)) throw artifactFailure('PDF artifact is missing', 410);
  try {
    const actualPath = realpathSync(path);
    if (!actualPath.startsWith(realpathSync(jobDir(row.id)) + sep)) throw artifactFailure('Invalid PDF artifact path', 409);
    const stat = statSync(actualPath);
    if (!stat.isFile() || stat.size > MAX_OUTPUT_BYTES || stat.size !== artifact.size) throw artifactFailure('PDF artifact checksum mismatch', 409);
    const verified = await hashPrintPdf(actualPath, stat.size);
    if (!verified?.isPdf || verified.hash !== artifact.sha256) throw artifactFailure('PDF artifact checksum mismatch', 409);
    const file = { ...artifact, path: actualPath, fingerprint: verified.fingerprint };
    assertUnchangedArtifact(file);
    return file;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw artifactFailure('PDF artifact is missing', 410);
    if (error.code === 'ELOOP') throw artifactFailure('Invalid PDF artifact path', 409);
    throw error;
  }
}

function recheckDownload(original, current, file) {
  assertArtifactAvailable(current);
  if (original.manifest_sha256 !== current.manifest_sha256 || original.manifest_json !== current.manifest_json) {
    throw printError('Print manifest changed during PDF verification', 409);
  }
  assertUnchangedArtifact(file);
  return file;
}

export async function ownedPrintArtifact(userId, deckId, id, artifactId) {
  const row = ownerJob(userId, deckId, id);
  const file = await verifiedPrintArtifact(row, artifactId);
  return recheckDownload(row, ownerJob(userId, deckId, id), file);
}

function neverClaimed(row) {
  return row.state === 'queued' && !row.station_id && !row.claim_nonce && !row.back_request_json && !row.cancel_requested
    && readSteps(row).every(step => ['pending', 'canceled'].includes(step.state) && !step.spoolerId && !step.submissionEventId
      && !step.submittingAt && !step.submittedAt && !step.completedAt && !step.attemptId && !step.attempts?.length && !step.refeedConfirmed)
    && !get('SELECT 1 FROM print_job_events WHERE job_id = ? LIMIT 1', [row.id]);
}

const ARTIFACT_ACTION = 'Resolve or cancel this exact batch before proceeding.';
export function blockedPrintArtifact(row) {
  if (!row?.error?.endsWith(ARTIFACT_ACTION)) return null;
  return /\(([a-zA-Z0-9_-]{1,128})\)\. $/.exec(row.error.slice(0, -ARTIFACT_ACTION.length))?.[1] ?? null;
}

async function verifyStationArtifact(row, artifactId, isolateUnclaimed = false) {
  try { return await verifiedPrintArtifact(row, artifactId); }
  catch (error) {
    if (!error.artifactUnavailable) throw error;
    const current = getPrintRow(row.id);
    if (!samePhysicalState(row, current)) throw error;
    const failure = `${error.message} (${artifactId}).`;
    if (isolateUnclaimed && neverClaimed(row)) {
      const at = now();
      runTransaction([{ sql: "UPDATE print_jobs SET state = 'failed', queue_requested = 0, error = ?, updated_at = ?, completed_at = ?, expires_at = ? WHERE id = ?",
        params: [`${failure} No print pass was submitted. Prepare a new batch to print it.`, at, at, retentionExpiry(), row.id] }]);
      return null;
    }
    if (['queued', 'backs_pending', ...ACTIVE_STATES].includes(row.state)) {
      const detail = `${failure} ${ARTIFACT_ACTION}`;
      if (current.error !== detail) run('UPDATE print_jobs SET error = ?, updated_at = ? WHERE id = ?', [detail, now(), row.id]);
    }
    throw error;
  }
}

export async function stationPrintArtifact(row, artifactId) {
  const file = await verifyStationArtifact(row, artifactId);
  return recheckDownload(row, stationPrintJob(row.id), file);
}

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
  if (rows.some(row => PHYSICAL_STATES.includes(row.state) || row.cancel_requested
    || (ACTIVE_STATES.includes(row.state) && row.back_request_json)
    || parse(row.steps_json).some(step => ['submitting', 'submitted', 'uncertain'].includes(step.state)))) {
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
  if (!Number.isSafeInteger(maxArtifacts) || maxArtifacts < 1 || maxArtifacts > MAX_PRINT_ARTIFACTS) {
    throw printError(`maxArtifacts must be an integer between 1 and ${MAX_PRINT_ARTIFACTS}`, 400);
  }
  const artifacts = parse(row.manifest_json)?.artifacts;
  if (!Array.isArray(artifacts)) throw printError('Print job manifest has no artifacts', 409);
  if (artifacts.length > maxArtifacts) {
    throw printError(`Upgrade the Mac print companion to continue this job: it has ${artifacts.length} PDF artifacts, but this companion supports ${maxArtifacts}.`, 409);
  }
}
export const hasMixedPrintSheets = row => parse(row.plan_json)?.sheetPacking === DOUBLE_FACED_FIRST;
export function assertStationWorkflow(row, deferredBacks, printRecovery = false, mixedPrintSheets = false) {
  if (hasMixedPrintSheets(row) && !(deferredBacks && mixedPrintSheets)) throw printError('Upgrade the Mac print companion to continue batches with mixed single- and double-sided sheets.', 409);
  if (isDeferred(row) && !deferredBacks) throw printError('Upgrade the Mac print companion to continue deferred back-side printing.', 409);
  if (!printRecovery && readSteps(row).some(step => step.attemptId)) throw printError('Upgrade the Mac print companion to continue a recovered physical print attempt.', 409);
}
export const savedPrintJobPaper = row => printJobPaper(parse(row.plan_json), parse(row.manifest_json));
const deferredStepOrder = steps => [...steps.filter(step => step.phase === 'fronts'), ...steps.filter(step => step.phase === 'backs')];

function renewLease(row) {
  if (Date.parse(row.lease_expires_at) - Date.now() > LEASE_RENEW_THRESHOLD_MS) return;
  const renewed = leaseExpiry();
  runTransaction([{ sql: 'UPDATE print_jobs SET lease_expires_at = ? WHERE id = ?', params: [renewed, row.id] }]);
  row.lease_expires_at = renewed;
}

export function claimPrintJob(options) {
  const claim = lastClaim.then(() => claimNextPrintJob(options));
  lastClaim = claim.catch(() => {});
  return claim;
}

async function claimNextPrintJob({ maxArtifacts = MAX_PRINT_ARTIFACTS, deferredBacks = false, printRecovery = false, paper = LEGACY_STATION_PAPER,
  eligibleRecipeIds = paper.supportedRecipeIds, mixedPrintSheets = false, mayClaim = () => true } = {}) {
  let row = all(`SELECT * FROM print_jobs WHERE station_id = ? AND state IN (${ACTIVE_STATES.map(() => '?').join(',')}) ORDER BY queued_at, created_at, id LIMIT 1`, [STATION_ID, ...ACTIVE_STATES])[0];
  if (row) { assertStationArtifactCapacity(row, maxArtifacts); assertStationWorkflow(row, deferredBacks, printRecovery, mixedPrintSheets); }
  if (row && row.state === 'claimed' && parse(row.steps_json).every(step => step.state === 'pending') && !printCapabilities(row.user_id).canQueue) {
    run("UPDATE print_jobs SET state = 'ready', queue_requested = 0, station_id = NULL, claim_nonce = NULL, error = ?, updated_at = ? WHERE id = ?", ['Printing authorization was revoked before submission', now(), row.id]);
    row = null;
  }
  if (row) {
    if (!paper.supportedRecipeIds.includes(savedPrintJobPaper(row).recipeId)) {
      throw printError('Upgrade the Mac companion to continue this batch’s paper size', 409);
    }
    if (row.state === 'claimed') renewLease(row);
    return formatPrintJob(row, true);
  }
  // Reserving a saved packet is exclusive only after the prior physical work
  // has finished. Its original nonce and receipts survive days of parking.
  function eligible(job) {
    const jobPaper = savedPrintJobPaper(job);
    return mayClaim(jobPaper) && eligibleRecipeIds.includes(jobPaper.recipeId) && stationCanPrintPaper(paper, jobPaper)
      && (!hasMixedPrintSheets(job) || (deferredBacks && mixedPrintSheets));
  }
  const requested = all("SELECT * FROM print_jobs WHERE station_id = ? AND state = 'backs_pending' AND back_request_json IS NOT NULL ORDER BY json_extract(back_request_json, '$.requestedAt'), id", [STATION_ID]);
  for (const saved of requested) {
    if (!samePhysicalState(saved, getPrintRow(saved.id))) continue;
    if (!eligible(saved)) continue;
    assertStationWorkflow(saved, deferredBacks, printRecovery, mixedPrintSheets);
    assertStationArtifactCapacity(saved, maxArtifacts);
    if (!printCapabilities(saved.user_id).canQueue) {
      run('UPDATE print_jobs SET back_request_json = NULL, updated_at = ? WHERE id = ?', [now(), saved.id]);
      continue;
    }
    const request = readBackRequest(saved);
    const file = await verifyStationArtifact(saved, request.artifactId);
    if (!samePhysicalState(saved, getPrintRow(saved.id)) || !eligible(saved) || !printCapabilities(saved.user_id).canQueue) continue;
    assertUnchangedArtifact(file);
    runTransaction([{ sql: "UPDATE print_jobs SET state = 'awaiting_refeed', error = NULL, lease_expires_at = ?, updated_at = ? WHERE id = ?",
      params: [leaseExpiry(), now(), saved.id] }]);
    return formatPrintJob(get('SELECT * FROM print_jobs WHERE id = ?', [saved.id]), true);
  }
  for (const queued of all("SELECT * FROM print_jobs WHERE state = 'queued' ORDER BY queued_at, created_at, id")) {
    if (!samePhysicalState(queued, getPrintRow(queued.id))) continue;
    row = queued;
    if (!printCapabilities(row.user_id).canQueue) {
      run("UPDATE print_jobs SET state = 'ready', queue_requested = 0, error = ?, updated_at = ? WHERE id = ?", ['Printing authorization was revoked; PDF remains available to its owner', now(), row.id]);
      continue;
    }
    if (!eligible(row)) continue;
    // Check compatibility before hashing PDFs or creating a durable claim. Older
    // companions can upgrade without trapping this FIFO job in claimed state.
    assertStationArtifactCapacity(row, maxArtifacts);
    assertStationWorkflow(row, deferredBacks, printRecovery, mixedPrintSheets);
    const files = [];
    for (const artifact of parse(row.manifest_json).artifacts) {
      const file = await verifyStationArtifact(row, artifact.id, true);
      if (!file) break;
      files.push(file);
    }
    if (!samePhysicalState(row, getPrintRow(row.id)) || !eligible(row) || !printCapabilities(row.user_id).canQueue) continue;
    files.forEach(assertUnchangedArtifact);
    const steps = readSteps(row), upgrade = deferredBacks && steps.every(step => step.state === 'pending');
    const ordered = upgrade ? deferredStepOrder(steps) : steps;
    runTransaction([{ sql: "UPDATE print_jobs SET state = 'claimed', station_id = ?, claim_nonce = ?, lease_expires_at = ?, updated_at = ?, workflow = ?, steps_json = ? WHERE id = ? AND state = 'queued'",
      params: [STATION_ID, row.claim_nonce || crypto.randomBytes(24).toString('hex'), leaseExpiry(), now(), upgrade ? DEFERRED_BACKS_WORKFLOW : row.workflow, json(ordered), row.id] }]);
    return formatPrintJob(get('SELECT * FROM print_jobs WHERE id = ?', [row.id]), true);
  }
  return null;
}
export function stationPrintJob(id) {
  const row = get('SELECT * FROM print_jobs WHERE id = ? AND station_id = ?', [id, STATION_ID]);
  if (!row) throw printError('Station print job not found', 404);
  return row;
}

export async function reportPrintJob(id, event) {
  const first = preparePrintReport(id, event);
  if (!first.artifactId) return first.commit();
  const file = await verifyStationArtifact(first.row, first.artifactId);
  const current = preparePrintReport(id, event);
  if (current.replayed) return current.commit();
  assertSamePhysicalState(first.row, current.row);
  assertUnchangedArtifact(file);
  return current.commit();
}

function preparePrintReport(id, event) {
  const row = stationPrintJob(id);
  safeId(event.eventId, 'eventId');
  if (typeof event.claimToken !== 'string' || !crypto.timingSafeEqual(Buffer.from(sha256(event.claimToken)), Buffer.from(sha256(claimToken(row))))) throw printError('Invalid job claim', 403);
  const eventHash = sha256(json(event));
  const previous = get('SELECT * FROM print_job_events WHERE job_id = ? AND event_id = ?', [id, event.eventId]);
  if (previous) {
    if (previous.request_hash !== eventHash) throw printError('This event ID was already used for a different station report', 409);
    return { replayed: true, commit: () => ({ job: formatPrintJob(row, true), replayed: true }) };
  }
  if (typeof event.detail === 'string' && event.detail.length > 2000) throw printError('Station detail is too long');
  if (event.spoolerId !== undefined && (typeof event.spoolerId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(event.spoolerId))) throw printError('Invalid spooler job ID');
  const steps = parse(row.steps_json), step = steps.find(item => item.artifactId === event.artifactId && item.phase === event.phase);
  const next = nextPrintStep(row, steps);
  let state = row.state, error = row.error, backRequest = row.back_request_json, cancellation = row.cancel_requested, cancellationId = row.cancel_request_id;
  let artifactId;
  if (step && (step.attemptId || event.attemptId) && event.attemptId !== step.attemptId) throw printError('This report belongs to a different physical print attempt', 409);
  if (['canceled', 'expired', 'failed', 'completed'].includes(row.state) && event.state !== 'reconciled') throw printError('This print job is no longer active', 409);
  if (event.state === 'heartbeat') {
    // Routine polls renew only near expiry. Physical decisions retain their
    // transaction/event receipts below.
    return { commit: () => {
      renewLease(row);
      return { job: formatPrintJob(row, true), replayed: false };
    } };
  } else if (event.state === 'recovery') {
    const command = typeof event.commandId === 'string' && get('SELECT * FROM print_station_commands WHERE id = ? AND station_id = ?', [event.commandId, STATION_ID]);
    const request = command && parse(command.payload_json);
    if (!command?.delivered_at || !['pending', 'applied', 'expired'].includes(command.status) || request?.type !== 'recover_print'
      || request.jobId !== row.id || request.artifactId !== event.artifactId || request.phase !== event.phase
      || request.spoolerId !== event.oldSpoolerId || ![6, 7, 8].includes(request.cupsState)
      || request.paperReady !== true || !request.firstUnprintedSheet || json(request.pages) !== json(event.pages)) throw printError('An exact delivered operator recovery command is required', 409);
    if (!step || step !== next || !['submitted', 'submitting', 'uncertain'].includes(step.state)
      || step.spoolerId !== event.oldSpoolerId || row.cancel_requested
      || (step.phase === 'backs' && request.paperReloaded !== true)) throw printError('This physical pass cannot be recovered', 409);
    const requester = get('SELECT is_admin, suspended FROM users WHERE id = ?', [command.requester_id]);
    if (!requester || requester.suspended || (!requester.is_admin && command.requester_id !== row.user_id)
      || (!requester.is_admin && !printCapabilities(command.requester_id).canQueue)) throw printError('Recovery requester is no longer authorized', 403);
    if (discordPrintCommandRejection(command)) throw printError('Discord recovery authorization is no longer valid', 403);
    if (!printCapabilities(row.user_id).canQueue) throw printError('Printing authorization was revoked', 403);
    artifactId = step.artifactId;
    const attempts = [...(step.attempts || []), { ...step, attempts: undefined, outcome: 'interrupted',
      recoveryCommandId: command.id, operatorConfirmedPrintedSheets: request.firstUnprintedSheet - 1, recoveredAt: now() }];
    for (const key of ['spoolerId', 'submittingAt', 'submittedAt', 'completedAt', 'submissionEventId', 'spoolerOutcome', 'detail']) delete step[key];
    Object.assign(step, { state: 'pending', attemptId: command.id, pages: request.pages, attempts });
    state = 'claimed'; error = null;
  } else if (event.state === 'submitting') {
    if (row.cancel_requested && (row.cancel_requested === 'all' || event.phase === 'backs')) throw printError('Cancellation is pending for this print pass', 409);
    if (row.lease_expires_at <= now()) throw printError('Claim lease expired; renew it before starting submission', 409);
    if (!printCapabilities(row.user_id).canQueue) throw printError('Printing authorization was revoked', 403);
    if (!step || step !== next || step.state !== 'pending' || !['claimed', 'submitted'].includes(row.state)) throw printError('This pass is not eligible for a new submission', 409);
    if (step.requiresRefeed && !step.refeedConfirmed) throw printError('An operator must confirm the paper flip/refeed before printing backs', 409);
    artifactId = step.artifactId;
    Object.assign(step, { state: 'submitting', submittingAt: now(), submissionEventId: event.eventId });
    state = 'submitting'; error = null;
  } else if (event.state === 'submitted') {
    if (!step || !['submitting', 'uncertain'].includes(step.state) || !event.spoolerId) throw printError('A submission intent and spooler ID are required', 409);
    Object.assign(step, { state: 'submitted', spoolerId: event.spoolerId, submittedAt: now() }); state = 'submitted'; error = null;
  } else if (event.state === 'completed') {
    if (!step || step.state !== 'submitted' || !event.spoolerId || step.spoolerId !== event.spoolerId) throw printError('Completion must match the acknowledged spooler job', 409);
    Object.assign(step, { state: 'completed', completedAt: now() });
    state = isDeferred(row) && step.phase === 'backs' ? 'awaiting_paper_reset' : settledPrintState(row, steps);
    error = null;
  } else if (event.state === 'awaiting_refeed') {
    if (!next?.requiresRefeed || next.refeedConfirmed || steps.some(item => ['submitting', 'submitted'].includes(item.state))) throw printError('This job is not ready for refeed', 409);
    state = 'awaiting_refeed';
  } else if (event.state === 'refeed') {
    if (row.cancel_requested) throw printError('This back pass has a pending cancellation', 409);
    const front = steps.find(item => item.artifactId === event.artifactId && item.phase === 'fronts');
    if (state !== 'awaiting_refeed' || !step || step !== next || step.phase !== 'backs'
      || !step.requiresRefeed || step.refeedConfirmed || step.state !== 'pending' || front?.state !== 'completed') {
      throw printError('This exact back pass is not waiting for a paper refeed after completed fronts', 409);
    }
    Object.assign(step, { refeedConfirmed: true, refeedAt: now() }); state = 'claimed';
  } else if (event.state === 'paper_ready') {
    if (!isDeferred(row) || row.state !== 'awaiting_paper_reset' || row.cancel_requested || event.paperCleared !== true || !paperClearanceId(row) || event.clearanceId !== paperClearanceId(row)) throw printError('Confirm blank paper is ready for this exact completed back pass', 409);
    state = settledPrintState(row, steps); backRequest = null;
  } else if (event.state === 'canceled') {
    if (!row.cancel_requested || event.paperCleared !== true || !paperClearanceId(row) || event.clearanceId !== paperClearanceId(row)) throw printError('Cancellation requires its saved request and exact confirmed paper clearance', 409);
    if (event.missingCupsHistory !== undefined) {
      const command = typeof event.commandId === 'string' && get('SELECT * FROM print_station_commands WHERE id = ? AND station_id = ?', [event.commandId, STATION_ID]);
      const request = command && parse(command.payload_json);
      if (event.missingCupsHistory !== true || !command?.delivered_at || !['pending', 'applied', 'expired'].includes(command.status)
        || request.type !== 'clear_missing_cups' || request.jobId !== id || request.clearanceId !== event.clearanceId
        || request.spoolerId !== event.spoolerId || request.paperCleared !== true
        || !step || step !== missingCancellationStep(row, event.spoolerId, steps)) {
        throw printError('Missing CUPS history requires an exact delivered cancellation clearance', 409);
      }
      const requester = get('SELECT is_admin, suspended FROM users WHERE id = ?', [command.requester_id]);
      if (!requester || requester.suspended || (!requester.is_admin && (command.requester_id !== row.user_id || !printCapabilities(command.requester_id).canQueue))) {
        throw printError('Cancellation clearance requester is no longer authorized', 403);
      }
    }
    for (const item of steps) {
      if (!finishedStep(item) && (row.cancel_requested === 'all' || item.phase === 'backs')) {
        Object.assign(item, { canceledFrom: item.state, state: 'canceled', canceledAt: now(), cancellationClearanceId: event.clearanceId });
      }
    }
    state = row.cancel_requested === 'all' ? 'canceled' : settledPrintState(row, steps);
    backRequest = null; cancellation = null; cancellationId = null; error = null;
  } else if (event.state === 'uncertain') {
    if (!step || !['submitting', 'submitted', 'uncertain'].includes(step.state)) throw printError('No submission exists to reconcile', 409);
    if (event.spoolerId && step.spoolerId && event.spoolerId !== step.spoolerId) throw printError('Uncertainty must retain the exact acknowledged spooler ID', 409);
    Object.assign(step, { state: 'uncertain', detail: event.detail || 'Submission outcome unknown',
      ...(event.spoolerId ? { spoolerId: event.spoolerId } : {}) }); state = 'uncertain'; error = step.detail;
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
      state = event.resolution === 'submitted' ? 'submitted' : isDeferred(row) && step.phase === 'backs' ? 'awaiting_paper_reset' : settledPrintState(row, steps);
    } else throw printError('Choose a verified reconciliation outcome and spooler ID where applicable');
    error = null;
  } else throw printError('Unsupported station event');
  // A completion acknowledgement racing an operator cancellation cannot drop
  // the physical reservation before the native station clears that request.
  if (cancellation && ['completed', 'canceled', 'backs_pending'].includes(state)) state = 'claimed';
  return { row, artifactId, commit: () => {
    runTransaction([
      { sql: `UPDATE print_jobs SET state = ?, steps_json = ?, error = ?, lease_expires_at = ?, updated_at = ?, completed_at = ?, expires_at = ?, back_request_json = ?, cancel_requested = ?, cancel_request_id = ? WHERE id = ?`,
        params: [state, json(steps), error, leaseExpiry(), now(), PRINT_TERMINAL_STATES.includes(state) ? now() : row.completed_at, state === 'backs_pending' ? null : PRINT_TERMINAL_STATES.includes(state) ? retentionExpiry() : row.expires_at, backRequest, cancellation, cancellationId, id] },
      { sql: 'INSERT INTO print_job_events (job_id, event_id, request_hash, event_json, created_at) VALUES (?, ?, ?, ?, ?)',
        params: [id, event.eventId, eventHash, json({ ...event, claimToken: undefined }), now()] },
    ]);
    return { job: formatPrintJob(getPrintRow(id), true), replayed: false };
  } };
}
