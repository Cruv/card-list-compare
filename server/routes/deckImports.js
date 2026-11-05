import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { archidektLimiter } from '../middleware/rateLimit.js';
import { createIntegrationDeck } from '../lib/deckCreation.js';
import { trackIntegrationSource } from '../lib/sourceTracking.js';
import { getInstanceId } from '../lib/integrationSchema.js';
import { parseDeckSourceUrl } from '../lib/deckSources.js';
import { ProposalError } from '../lib/deckProposals.js';
import { validProposalText } from '../lib/proposalLimits.js';
import { parse } from '../../src/lib/parser.js';

const fields = new Set(['operationId', 'name', 'deckText', 'sourceUrl']);
const messages = {
  operation_conflict: 'This saved request already belongs to different deck details. Recover the original request first.',
  source_identity_conflict: 'More than one saved deck matches this source. Review the existing decks before importing.',
  created_deck_deleted: 'The deck created by this request was deleted. Start a new import to create another deck.',
  tracked_deck_deleted: 'The deck tracked by this request was deleted. Start a new import to track it again.',
};

/** Session-authenticated adapter; integration credentials never enter this flow. */
export function createDeckImportRouter({ createManual = createIntegrationDeck, trackSource = trackIntegrationSource } = {}) {
  const router = Router();
  router.use(requireAuth);
  router.post('/', archidektLimiter, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.has(key))) {
      return res.status(400).json({ error: 'Use a deck name and card list, or a supported source URL.' });
    }
    const source = body.sourceUrl === undefined ? null : typeof body.sourceUrl === 'string' && body.sourceUrl.length <= 2000 && parseDeckSourceUrl(body.sourceUrl);
    if (body.sourceUrl !== undefined && !source) return res.status(400).json({ error: 'Automatic tracking supports Archidekt, Moxfield and DeckCheck deck URLs.' });
    if ((!source || body.name !== undefined) && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200)) {
      return res.status(400).json({ error: 'Enter a deck name of up to 200 characters.' });
    }
    if (!source || body.deckText !== undefined) {
      if (!validProposalText(body.deckText)) return res.status(400).json({ error: 'The card list is missing or too long.' });
      const parsed = parse(body.deckText);
      if (parsed.mainboard.size + parsed.sideboard.size === 0) return res.status(400).json({ error: 'No cards were found. Paste a card list with quantities, such as 1 Sol Ring.' });
    }
    const input = { operationId: body.operationId, expectedInstanceId: getInstanceId(), expectedAccountId: String(req.user.userId),
      ...(body.name !== undefined ? { name: body.name } : {}), ...(body.deckText !== undefined ? { deckText: body.deckText } : {}) };
    try {
      const result = source
        ? await trackSource(req.user.userId, { ...input, sourceLink: source })
        : createManual(req.user.userId, input, { snapshotLabel: 'Imported card list' });
      return res.status(result.replayed || result.linkedExisting ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof ProposalError) return res.status(error.status).json({ error: messages[error.code] || 'The deck could not be imported. Check the list and retry the same request.', code: error.code });
      console.error('Library deck import failed');
      return res.status(500).json({ error: 'The import result could not be confirmed. Retry the same request to recover it.' });
    }
  });
  return router;
}

export default createDeckImportRouter();
