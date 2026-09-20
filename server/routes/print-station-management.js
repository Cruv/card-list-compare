import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createStationCommand, printStationStatus } from '../lib/printStationManagement.js';

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const route = callback => (req, res) => {
  try { callback(req, res); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Station management is unavailable' }); }
};
router.get('/status', route((req, res) => res.json(printStationStatus(req.user.userId))));
router.post('/commands', route((req, res) => res.json(createStationCommand(req.user.userId, req.body))));
export default router;
