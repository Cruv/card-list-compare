import { Router } from 'express';
import { all } from '../db.js';
import { requireIntegration } from '../middleware/integrationAuth.js';
import { getInstanceId } from '../lib/integrationSchema.js';
import { serializeDeck } from '../lib/structuredSnapshots.js';
import { createIntegrationDeck } from '../lib/deckCreation.js';
import { ProposalError } from '../lib/deckProposals.js';
import { trackIntegrationSource, SOURCE_TRACKING_PROVIDERS } from '../lib/sourceTracking.js';

export function createStructuredDeckRouter({ trackSource = trackIntegrationSource } = {}) {
const router = Router();

function context(req) {
  return { version: 1, instanceId: getInstanceId(), accountId: String(req.user.userId),
    capabilities: { proposals: true, deckCreation: true, sourceLinks: true, sourceTracking: SOURCE_TRACKING_PROVIDERS }, scopes: req.integrationScopes };
}

router.get('/context', requireIntegration('decks:read'), (req, res) => res.json(context(req)));
router.get('/decks', requireIntegration('decks:read'), (req, res) => {
  const decks = all('SELECT * FROM tracked_decks WHERE user_id = ? ORDER BY id', [req.user.userId]).map(serializeDeck);
  res.json({ ...context(req), decks });
});
router.post('/decks', requireIntegration('decks:create'), (req, res, next) => {
  try {
    const { deck, operationId, replayed, linkedExisting } = createIntegrationDeck(req.user.userId, req.body);
    res.status(replayed || linkedExisting ? 200 : 201).json({ ...context(req), decks: [deck], operationId, replayed, linkedExisting });
  } catch (error) {
    if (error instanceof ProposalError) res.status(error.status).json({ error: error.code, message: error.message });
    else next(error);
  }
});
router.post('/decks/track-source', requireIntegration('decks:create'), async (req, res, next) => {
  try {
    const { deck, operationId, replayed, linkedExisting, tracking } = await trackSource(req.user.userId, req.body);
    res.status(replayed || linkedExisting ? 200 : 201).json({ ...context(req), decks: [deck], operationId, replayed, linkedExisting, tracking });
  } catch (error) {
    if (error instanceof ProposalError) res.status(error.status).json({ error: error.code, message: error.message });
    else next(error);
  }
});
return router;
}

export default createStructuredDeckRouter();
