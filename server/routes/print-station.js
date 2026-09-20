import { Router } from 'express';
import { requireStationToken, stationPrintJob, reportPrintJob, formatPrintJob, verifiedPrintArtifact } from '../lib/printQueue.js';
import { claimForManagedStation, stationManagementHeartbeat } from '../lib/printStationManagement.js';
import { sendPdf } from './print.js';

const router = Router();
router.use((req, res, next) => {
  try {
    const header = req.headers.authorization;
    requireStationToken(typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '');
    next();
  } catch (error) { res.status(error.status || 401).json({ error: error.message }); }
});
const route = callback => (req, res) => {
  try { callback(req, res); }
  catch (error) {
    if (res.headersSent) return res.destroy(error);
    res.status(error.status || 500).json({ error: error.message });
  }
};
router.get('/status', (_req, res) => res.json({ stationId: 'household', recipeId: 'household-letter-v6', protocolVersion: 1 }));
router.post('/heartbeat', route((req, res) => res.json(stationManagementHeartbeat(req.body))));
router.post('/claim', route((_req, res) => res.json({ job: claimForManagedStation() })));
router.get('/jobs/:jobId', route((req, res) => res.json({ job: formatPrintJob(stationPrintJob(req.params.jobId), true) })));
router.post('/jobs/:jobId/report', route((req, res) => res.json(reportPrintJob(req.params.jobId, req.body || {}))));
router.get('/jobs/:jobId/artifacts/:artifactId', route((req, res) => {
  const row = stationPrintJob(req.params.jobId);
  sendPdf(res, verifiedPrintArtifact(row, req.params.artifactId));
}));
export default router;
