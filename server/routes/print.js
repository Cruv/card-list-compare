import { Router } from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { requireAuth } from '../middleware/auth.js';
import { buildPrintPlan, publicPrintPlan, printError, sha256 } from '../lib/printQueuePlan.js';
import { openVerifiedPrintPdf } from '../lib/printPdfHash.js';
import {
  printCapabilities, createPrintJob, listPrintJobs, getOwnedPrintJob,
  queuePrintJob, cancelPrintJob, ownedPrintArtifact, ownedPrintManifest, expireOwnedPrintArtifacts,
  reviewAlternatePrintLayout, createAlternatePrintLayout,
} from '../lib/printQueue.js';
import { getPrintGeneratorStatus } from '../lib/printGenerator.js';
import { listPrintBatches, listPrintJobActivity } from '../lib/printBatchHistory.js';
import { assertQueuePaper, printStationPaperReadiness, supportsDeferredBacks } from '../lib/printStationManagement.js';
import { savePrintArtToDeck } from '../lib/printDeckArt.js';

const router = Router();
router.use(requireAuth);
export const standalonePrintRouter = Router();
standalonePrintRouter.use(requireAuth);
export const printBatchesRouter = Router();
printBatchesRouter.use(requireAuth);
printBatchesRouter.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
export const printDownloadsRouter = Router();

const downloadGrants = new Map();
const downloadReceipts = new Map();
const downloadMaxAge = 60_000;
const receiptMaxAge = 120_000;
const downloadCookie = 'clc-pdf-download';
const restartDownload = 'PDF download expired. Start it again from the batch.';
const unavailablePdf = 'This PDF is missing or expired. Refresh batches and generate a new PDF if you still need it.';
const changedPdf = 'This PDF changed or failed verification. Refresh batches and generate a new PDF if you still need it.';
const deckId = req => {
  const value = Number(req.params.deckId);
  if (!/^\d+$/.test(req.params.deckId) || !Number.isSafeInteger(value) || value < 1) throw printError('Invalid deck ID');
  return value;
};
const route = callback => async (req, res, next) => {
  try { await callback(req, res, next); }
  catch (error) {
    if (res.headersSent) return res.destroy(error);
    res.status(error.status || 500).json({ error: error.message });
  }
};

function startPdfDownload(req, res, deck) {
  const { jobId, artifactId } = req.params;
  const userId = req.user.userId;
  const authorization = req.get('authorization');
  const job = getOwnedPrintJob(userId, deck, jobId);
  if (!job.manifestSha256 || job.state === 'expired') throw printError(unavailablePdf, 410);
  const artifact = job.artifacts.find(item => item.id === artifactId);
  if (!artifact) throw printError(unavailablePdf, 404);
  if (downloadGrants.size >= 256 || [...downloadGrants.values()].filter(grant => grant.userId === userId).length >= 8) {
    throw printError('Too many PDF downloads are starting. Try again shortly.', 429);
  }

  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const path = `/api/print-downloads/${id}`;
  const expiresAt = Date.now() + downloadMaxAge;
  const receipt = req.body?.reportStatus === true ? createDownloadReceipt(id, userId, authorization) : null;
  const timer = setTimeout(() => {
    downloadGrants.delete(id);
    setDownloadReceipt(receipt, { state: 'failed', error: restartDownload });
  }, downloadMaxAge);
  timer.unref();
  const stem = typeof req.body?.filename === 'string'
    ? req.body.filename.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 170).trim() : '';
  const options = { path, httpOnly: true, sameSite: 'strict', secure: req.secure };
  downloadGrants.set(id, { userId, deck, jobId, artifactId, hash: artifact.sha256, authorization,
    filename: `${stem || `clc-${artifactId}`}.pdf`, token, expiresAt, options, timer, receipt });
  res.cookie(downloadCookie, token, { ...options, maxAge: downloadMaxAge }).json({ url: path, ...(receipt ? { reportStatus: true } : {}) });
}

function createDownloadReceipt(id, userId, authorization) {
  if (downloadReceipts.size >= 256) {
    const finished = [...downloadReceipts].find(([, entry]) => entry.result);
    if (!finished) throw printError('Too many PDF downloads are starting. Try again shortly.', 429);
    clearTimeout(finished[1].timer);
    downloadReceipts.delete(finished[0]);
  }
  const timer = setTimeout(() => downloadReceipts.delete(id), receiptMaxAge);
  timer.unref();
  const receipt = { userId, sessionHash: sha256(authorization), timer };
  downloadReceipts.set(id, receipt);
  return receipt;
}

function setDownloadReceipt(receipt, result) {
  if (receipt && !receipt.result) receipt.result = result;
}

function reportDownloadFailure(res, receipt) {
  if (receipt.result) return;
  const status = res.statusCode;
  const error = status === 404 || status === 410 ? unavailablePdf : status === 409 ? changedPdf
    : status === 401 || status === 403 ? 'Your session no longer has access. Sign in again and reopen the batch.'
      : 'The PDF download could not start. Check your browser’s downloads, then try again from the batch.';
  setDownloadReceipt(receipt, { state: 'failed', error });
}

// An attachment navigation cannot supply the bearer header used by the app.
// Exchange it for a one-use cookie scoped to an opaque URL, and revalidate the
// original session and exact artifact before streaming any bytes.
printDownloadsRouter.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
  next();
});
printDownloadsRouter.get('/:id/status', requireAuth, (req, res) => {
  const receipt = downloadReceipts.get(req.params.id);
  if (receipt?.userId !== req.user.userId || receipt.sessionHash !== sha256(req.get('authorization'))) {
    return res.status(404).json({ error: restartDownload });
  }
  res.json(receipt.result || { state: 'pending' });
});
printDownloadsRouter.head('/:id', (_req, res) => res.sendStatus(405));
printDownloadsRouter.get('/:id', (req, res, next) => {
  const grant = downloadGrants.get(req.params.id);
  const cookie = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(`${downloadCookie}=`))?.slice(downloadCookie.length + 1);
  if (!grant || !cookie || !/^[a-zA-Z0-9_-]{43}$/.test(cookie)
    || !timingSafeEqual(Buffer.from(cookie), Buffer.from(grant.token))) {
    return res.status(404).json({ error: restartDownload });
  }
  downloadGrants.delete(req.params.id);
  clearTimeout(grant.timer);
  res.clearCookie(downloadCookie, grant.options);
  if (grant.expiresAt <= Date.now()) {
    setDownloadReceipt(grant.receipt, { state: 'failed', error: restartDownload });
    return res.status(404).json({ error: restartDownload });
  }
  if (grant.receipt) res.once('close', () => reportDownloadFailure(res, grant.receipt));
  req.headers.authorization = grant.authorization;
  res.locals.download = grant;
  next();
}, requireAuth, route(async (req, res, next) => {
  const { userId, deck, jobId, artifactId, hash } = res.locals.download;
  if (req.user.userId !== userId) throw printError(restartDownload, 404);
  const artifact = await ownedPrintArtifact(userId, deck, jobId, artifactId);
  if (artifact.sha256 !== hash) throw printError('The saved PDF changed. Start its download again from the batch.', 409);
  res.locals.verifiedPdf = artifact;
  next();
}), requireAuth, route((_req, res) => {
  const { filename, receipt } = res.locals.download;
  return sendPdf(res, res.locals.verifiedPdf, filename, receipt ? () => setDownloadReceipt(receipt, { state: 'started' }) : undefined);
}));
function sendActivity(req, res, deck) {
  const { userId } = req.user;
  const capabilities = printCapabilities(userId);
  res.set('Cache-Control', 'private, no-store').json({ ...listPrintJobActivity(userId, deck, req.query.watch),
    capabilities, generator: getPrintGeneratorStatus(), station: capabilities.canQueue ? printStationPaperReadiness() : null });
}
printBatchesRouter.get('/', route((req, res) => res.json(listPrintBatches(req.user.userId, req.query, { deferredBacks: supportsDeferredBacks() }))));
router.post('/:deckId/print-plan', route(async (req, res) => {
  const plan = await buildPrintPlan(req.user.userId, deckId(req), req.body || {});
  res.json({ plan: publicPrintPlan(plan), capabilities: printCapabilities(req.user.userId), generator: getPrintGeneratorStatus() });
}));
router.post('/:deckId/print-art', route(async (req, res) => {
  const result = await savePrintArtToDeck(req.user.userId, deckId(req), req.body || {});
  res.status(result.changed ? 201 : 200).json(result);
}));
router.get('/:deckId/print-jobs', route((req, res) => {
  res.json({ jobs: listPrintJobs(req.user.userId, deckId(req)), capabilities: printCapabilities(req.user.userId), generator: getPrintGeneratorStatus() });
}));
router.post('/:deckId/print-jobs', route(async (req, res) => {
  const result = await createPrintJob(req.user.userId, deckId(req), req.body || {}, assertQueuePaper);
  res.status(result.isExisting ? 200 : 202).json(result);
}));
router.get('/:deckId/print-jobs/activity', route((req, res) => sendActivity(req, res, deckId(req))));
router.get('/:deckId/print-jobs/:jobId', route((req, res) => {
  res.json({ job: getOwnedPrintJob(req.user.userId, deckId(req), req.params.jobId) });
}));
router.post('/:deckId/print-jobs/:jobId/queue', route(async (req, res) => {
  res.json({ job: await queuePrintJob(req.user.userId, deckId(req), req.params.jobId, assertQueuePaper) });
}));
router.post('/:deckId/print-jobs/:jobId/cancel', route((req, res) => {
  res.json({ job: cancelPrintJob(req.user.userId, deckId(req), req.params.jobId) });
}));
router.delete('/:deckId/print-jobs/:jobId/artifacts', route((req, res) => {
  res.json({ job: expireOwnedPrintArtifacts(req.user.userId, deckId(req), req.params.jobId) });
}));
router.get('/:deckId/print-jobs/:jobId/manifest', route((req, res) => {
  res.set('Cache-Control', 'private, no-store').json(ownedPrintManifest(req.user.userId, deckId(req), req.params.jobId));
}));
const verifyOwnedPdf = lookupDeckId => route(async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.locals.verifiedPdf = await ownedPrintArtifact(req.user.userId, lookupDeckId(req), req.params.jobId, req.params.artifactId);
  next();
});
const sendVerifiedPdf = route((_req, res) => sendPdf(res, res.locals.verifiedPdf));
const verifyAlternateLayout = lookupDeckId => route(async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  try {
    res.locals.alternateLayout = await reviewAlternatePrintLayout(req.user.userId, lookupDeckId(req), req.params.jobId,
      req.body || {}, controller.signal);
    if (!controller.signal.aborted) next();
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally { res.off('close', abort); }
});
const sendAlternateLayout = (req, res) => res.json({ ...res.locals.alternateLayout,
  capabilities: printCapabilities(req.user.userId), generator: getPrintGeneratorStatus() });
const prepareAlternateLayout = lookupDeckId => route((req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const result = createAlternatePrintLayout(req.user.userId, lookupDeckId(req), req.params.jobId, req.body || {});
  res.status(result.isExisting ? 200 : 202).json(result);
});
router.post('/:deckId/print-jobs/:jobId/alternate-layout/preview', verifyAlternateLayout(deckId), requireAuth, sendAlternateLayout);
router.post('/:deckId/print-jobs/:jobId/alternate-layout', prepareAlternateLayout(deckId));
router.get('/:deckId/print-jobs/:jobId/artifacts/:artifactId', verifyOwnedPdf(deckId), requireAuth, sendVerifiedPdf);
router.post('/:deckId/print-jobs/:jobId/artifacts/:artifactId/download', route((req, res) => {
  res.set('Cache-Control', 'private, no-store');
  startPdfDownload(req, res, deckId(req));
}));
standalonePrintRouter.post('/plan', route(async (req, res) => {
  const plan = await buildPrintPlan(req.user.userId, null, req.body || {});
  res.json({ plan: publicPrintPlan(plan), capabilities: printCapabilities(req.user.userId), generator: getPrintGeneratorStatus() });
}));
standalonePrintRouter.get('/jobs', route((req, res) => {
  res.json({ jobs: listPrintJobs(req.user.userId, null), capabilities: printCapabilities(req.user.userId), generator: getPrintGeneratorStatus() });
}));
standalonePrintRouter.post('/jobs', route(async (req, res) => {
  const result = await createPrintJob(req.user.userId, null, req.body || {}, assertQueuePaper);
  res.status(result.isExisting ? 200 : 202).json(result);
}));
standalonePrintRouter.get('/jobs/activity', route((req, res) => sendActivity(req, res, null)));
standalonePrintRouter.get('/jobs/:jobId', route((req, res) => {
  res.json({ job: getOwnedPrintJob(req.user.userId, null, req.params.jobId) });
}));
standalonePrintRouter.post('/jobs/:jobId/queue', route(async (req, res) => {
  res.json({ job: await queuePrintJob(req.user.userId, null, req.params.jobId, assertQueuePaper) });
}));
standalonePrintRouter.post('/jobs/:jobId/cancel', route((req, res) => {
  res.json({ job: cancelPrintJob(req.user.userId, null, req.params.jobId) });
}));
standalonePrintRouter.delete('/jobs/:jobId/artifacts', route((req, res) => {
  res.json({ job: expireOwnedPrintArtifacts(req.user.userId, null, req.params.jobId) });
}));
standalonePrintRouter.get('/jobs/:jobId/manifest', route((req, res) => {
  res.set('Cache-Control', 'private, no-store').json(ownedPrintManifest(req.user.userId, null, req.params.jobId));
}));
standalonePrintRouter.post('/jobs/:jobId/alternate-layout/preview', verifyAlternateLayout(() => null), requireAuth, sendAlternateLayout);
standalonePrintRouter.post('/jobs/:jobId/alternate-layout', prepareAlternateLayout(() => null));
standalonePrintRouter.get('/jobs/:jobId/artifacts/:artifactId', verifyOwnedPdf(() => null), requireAuth, sendVerifiedPdf);
standalonePrintRouter.post('/jobs/:jobId/artifacts/:artifactId/download', route((req, res) => {
  res.set('Cache-Control', 'private, no-store');
  startPdfDownload(req, res, null);
}));
export function sendPdf(res, artifact, filename = `clc-${artifact.id}.pdf`, onStart) {
  let stream;
  try {
    stream = artifact.fingerprint ? openVerifiedPrintPdf(artifact.path, artifact.fingerprint) : createReadStream(artifact.path);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw printError(unavailablePdf, 410);
    if (['ELOOP', 'ESTALE'].includes(error.code)) throw printError(changedPdf, 409);
    throw error;
  }
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(artifact.size),
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-SHA256': artifact.sha256 });
  if (onStart) stream.once('data', onStart);
  return pipeline(stream, res).catch(error => res.destroy(error));
}
export default router;
