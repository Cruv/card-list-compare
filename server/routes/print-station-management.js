import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createStationCommand, printStationStatus, createDiscordCommand, findStationCommand, cancelHouseholdPrintJob, prepareHouseholdBacks, cancelHouseholdBacks } from '../lib/printStationManagement.js';

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const route = callback => (req, res) => {
  try { callback(req, res); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Station management is unavailable' }); }
};
router.get('/status', route((req, res) => res.json(printStationStatus(req.user.userId))));
router.post('/jobs/:jobId/cancel', route((req, res) => res.json(cancelHouseholdPrintJob(req.user.userId, req.params.jobId))));
router.post('/jobs/:jobId/backs/prepare', route((req, res) => res.json(prepareHouseholdBacks(req.user.userId, req.params.jobId, req.body))));
router.post('/jobs/:jobId/backs/cancel', route((req, res) => res.json(cancelHouseholdBacks(req.user.userId, req.params.jobId))));
router.post('/commands', route((req, res) => res.json(createStationCommand(req.user.userId, req.body))));
router.get('/commands/:key', route((req, res) => res.json(findStationCommand(req.user.userId, req.params.key))));
router.post('/discord', route((req, res) => res.json(createDiscordCommand(req.user.userId, req.body))));
router.post('/discord/test', route((req, res) => res.json(createDiscordCommand(req.user.userId, { ...req.body, type: 'test_discord' }))));
export default router;
