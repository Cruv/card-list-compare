import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { SourceSyncError, sourceSyncState, reviewSource } from '../lib/sourceSync.js';

const router = Router();
router.use(requireAuth);
const handle = fn => (req, res, next) => {
  try { res.json(fn(req)); }
  catch (error) {
    if (error instanceof SourceSyncError) res.status(error.status).json({ error: error.code, message: error.message });
    else next(error);
  }
};
router.get('/:deckId/source-sync', handle(req => sourceSyncState(req.user.userId, req.params.deckId)));
router.post('/:deckId/source-sync/review', handle(req => reviewSource(req.user.userId, req.params.deckId, req.body)));
export default router;
