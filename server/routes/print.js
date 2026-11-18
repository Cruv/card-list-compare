import { Router } from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { requireAuth } from '../middleware/auth.js';
import { buildPrintPlan, publicPrintPlan, printError } from '../lib/printQueuePlan.js';
import {
  printCapabilities, createPrintJob, listPrintJobs, getOwnedPrintJob,
  queuePrintJob, cancelPrintJob, ownedPrintArtifact, ownedPrintManifest, expireOwnedPrintArtifacts,
} from '../lib/printQueue.js';
import { getPrintGeneratorStatus } from '../lib/printGenerator.js';
import { listPrintBatches, listPrintJobActivity } from '../lib/printBatchHistory.js';
import { assertQueuePaper, supportsDeferredBacks } from '../lib/printStationManagement.js';
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
const downloadMaxAge = 60_000;
const downloadCookie = 'clc-pdf-download';
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
  const job = getOwnedPrintJob(userId, deck, jobId);
  if (!job.manifestSha256 || job.state === 'expired') throw printError('PDF is unavailable or expired', 410);
  const artifact = job.artifacts.find(item => item.id === artifactId);
  if (!artifact) throw printError('PDF artifact not found', 404);
  if (downloadGrants.size >= 256 || [...downloadGrants.values()].filter(grant => grant.userId === userId).length >= 8) {
    throw printError('Too many PDF downloads are starting. Try again shortly.', 429);
  }

  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const path = `/api/print-downloads/${id}`;
  const expiresAt = Date.now() + downloadMaxAge;
  const timer = setTimeout(() => downloadGrants.delete(id), downloadMaxAge);
  timer.unref();
  const stem = typeof req.body?.filename === 'string'
    ? req.body.filename.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 170).trim() : '';
  const options = { path, httpOnly: true, sameSite: 'strict', secure: req.secure };
  downloadGrants.set(id, { userId, deck, jobId, artifactId, hash: artifact.sha256, authorization: req.get('authorization'),
    filename: `${stem || `clc-${artifactId}`}.pdf`, token, expiresAt, options, timer });
  res.cookie(downloadCookie, token, { ...options, maxAge: downloadMaxAge }).json({ url: path });
}

// An attachment navigation cannot supply the bearer header used by the app.
// Exchange it for a one-use cookie scoped to an opaque URL, and revalidate the
// original session and exact artifact before streaming any bytes.
printDownloadsRouter.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
  next();
});
printDownloadsRouter.head('/:id', (_req, res) => res.sendStatus(405));
printDownloadsRouter.get('/:id', (req, res, next) => {
  const grant = downloadGrants.get(req.params.id);
  const cookie = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(`${downloadCookie}=`))?.slice(downloadCookie.length + 1);
  if (!grant || grant.expiresAt <= Date.now() || !cookie || !/^[a-zA-Z0-9_-]{43}$/.test(cookie)
    || !timingSafeEqual(Buffer.from(cookie), Buffer.from(grant.token))) {
    return res.status(404).json({ error: 'PDF download expired. Start it again from the batch.' });
  }
  downloadGrants.delete(req.params.id);
  clearTimeout(grant.timer);
  res.clearCookie(downloadCookie, grant.options);
  req.headers.authorization = grant.authorization;
  res.locals.download = grant;
  next();
}, requireAuth, route(async (req, res, next) => {
  const { userId, deck, jobId, artifactId, hash } = res.locals.download;
  if (req.user.userId !== userId) throw printError('PDF download expired. Start it again from the batch.', 404);
  const artifact = await ownedPrintArtifact(userId, deck, jobId, artifactId);
  if (artifact.sha256 !== hash) throw printError('The saved PDF changed. Start its download again from the batch.', 409);
  res.locals.verifiedPdf = artifact;
  next();
}), requireAuth, route((_req, res) => sendPdf(res, res.locals.verifiedPdf, res.locals.download.filename)));
function sendActivity(res, userId, deck) {
  res.set('Cache-Control', 'private, no-store').json({ ...listPrintJobActivity(userId, deck),
    capabilities: printCapabilities(userId), generator: getPrintGeneratorStatus() });
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
router.get('/:deckId/print-jobs/activity', route((req, res) => sendActivity(res, req.user.userId, deckId(req))));
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
  res.locals.verifiedPdf = await ownedPrintArtifact(req.user.userId, lookupDeckId(req), req.params.jobId, req.params.artifactId);
  next();
});
const sendVerifiedPdf = route((_req, res) => sendPdf(res, res.locals.verifiedPdf));
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
standalonePrintRouter.get('/jobs/activity', route((req, res) => sendActivity(res, req.user.userId, null)));
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
standalonePrintRouter.get('/jobs/:jobId/artifacts/:artifactId', verifyOwnedPdf(() => null), requireAuth, sendVerifiedPdf);
standalonePrintRouter.post('/jobs/:jobId/artifacts/:artifactId/download', route((req, res) => {
  res.set('Cache-Control', 'private, no-store');
  startPdfDownload(req, res, null);
}));
export function sendPdf(res, artifact, filename = `clc-${artifact.id}.pdf`) {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(artifact.size),
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-SHA256': artifact.sha256 });
  return pipeline(createReadStream(artifact.path), res).catch(error => res.destroy(error));
}
export default router;
