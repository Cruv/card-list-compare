import express from 'express';
import { MAX_BODY_SIZE } from './validate.js';
import { MAX_PROPOSAL_BODY_SIZE } from '../lib/proposalLimits.js';
import { requireIntegration } from './integrationAuth.js';
import { requireAuth } from './auth.js';

const jsonBody = express.Router();
const proposalBody = express.json({ limit: MAX_PROPOSAL_BODY_SIZE });

// Authorize before accepting the larger envelope. The route checks again after
// parsing, retaining its existing account/scope and review-version protections.
jsonBody.post('/api/decks/:deckId/proposals', requireIntegration('decks:propose'), proposalBody);
jsonBody.post('/api/decks/:deckId/proposals/:proposalId/review', requireAuth, proposalBody);
jsonBody.post(['/api/integrations/v1/decks', '/api/integrations/v1/decks/track-source'],
  requireIntegration('decks:create'), proposalBody);
jsonBody.use(express.json({ limit: MAX_BODY_SIZE }));

export default jsonBody;
