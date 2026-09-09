import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { requireAuth } from '../middleware/auth.js';
import { buildPrintPlan, publicPrintPlan, printError } from '../lib/printQueuePlan.js';
import {
  printCapabilities, createPrintJob, listPrintJobs, getOwnedPrintJob,
  queuePrintJob, cancelPrintJob, ownedPrintArtifact, ownedPrintManifest, expireOwnedPrintArtifacts,
} from '../lib/printQueue.js';
import { getPrintGeneratorStatus } from '../lib/printGenerator.js';

const router = Router();
router.use(requireAuth);
const deckId = req => {
  const value = Number(req.params.deckId);
  if (!/^\d+$/.test(req.params.deckId) || !Number.isSafeInteger(value) || value < 1) throw printError('Invalid deck ID');
  return value;
};
const route = callback => async (req, res) => {
  try { await callback(req, res); }
  catch (error) {
    if (res.headersSent) return res.destroy(error);
    res.status(error.status || 500).json({ error: error.message });
  }
};
router.post('/:deckId/print-plan', route((req, res) => {
  const plan = buildPrintPlan(req.user.userId, deckId(req), req.body || {});
  res.json({ plan: publicPrintPlan(plan), capabilities: printCapabilities(req.user.userId), generator: getPrintGeneratorStatus() });
}));
router.get('/:deckId/print-jobs', route((req, res) => {
  res.json({ jobs: listPrintJobs(req.user.userId, deckId(req)), capabilities: printCapabilities(req.user.userId), generator: getPrintGeneratorStatus() });
}));
router.post('/:deckId/print-jobs', route((req, res) => {
  const result = createPrintJob(req.user.userId, deckId(req), req.body || {});
  res.status(result.isExisting ? 200 : 202).json(result);
}));
router.get('/:deckId/print-jobs/:jobId', route((req, res) => {
  res.json({ job: getOwnedPrintJob(req.user.userId, deckId(req), req.params.jobId) });
}));
router.post('/:deckId/print-jobs/:jobId/queue', route((req, res) => {
  res.json({ job: queuePrintJob(req.user.userId, deckId(req), req.params.jobId) });
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
router.get('/:deckId/print-jobs/:jobId/artifacts/:artifactId', route((req, res) => {
  const artifact = ownedPrintArtifact(req.user.userId, deckId(req), req.params.jobId, req.params.artifactId);
  sendPdf(res, artifact);
}));
export function sendPdf(res, artifact) {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(artifact.size),
    'Content-Disposition': `attachment; filename="clc-${artifact.id}.pdf"`,
    'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no', 'X-Content-SHA256': artifact.sha256 });
  createReadStream(artifact.path).on('error', error => res.destroy(error)).pipe(res);
}
export default router;
