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

// Express populates req.query; read the raw URL too so a router mounted without the query
// parser (and any direct handler call) reads the same request.
function requestedInclude(req) {
  if (req.query && typeof req.query.include === 'string') return req.query.include;
  return new URLSearchParams(String(req.originalUrl || req.url || '').split('?')[1] || '').get('include') || '';
}

router.get('/context', requireIntegration('decks:read'), (req, res) => res.json(context(req)));
// Default: every snapshot of every deck with its text and parsed cards — the full history an
// archiver wants. `?include=latest`: the current and paper snapshots only, with their IDs,
// text and hashes, which is all a collection mirror keeps and is O(decks) instead of
// O(snapshots) of text plus a deck-text parse each.
router.get('/decks', requireIntegration('decks:read'), (req, res) => {
  const include = requestedInclude(req) === 'latest' ? 'latest' : undefined;
  const decks = all('SELECT * FROM tracked_decks WHERE user_id = ? ORDER BY id', [req.user.userId])
    .map(deck => serializeDeck(deck, { include }));
  res.json({ ...context(req), ...(include ? { include } : {}), decks });
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
